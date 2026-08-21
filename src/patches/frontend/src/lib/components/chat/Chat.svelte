<script lang="ts">
	import { v4 as uuidv4 } from 'uuid';
	import { toast } from 'svelte-sonner';
	import { PaneGroup, Pane, PaneResizer } from 'paneforge';

	import { getContext, onDestroy, onMount, setContext, tick } from 'svelte';
	import { fade } from 'svelte/transition';
	const i18n: Writable<i18nType> = getContext('i18n');

	import { browser } from '$app/environment';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/stores';

	import { get, writable, type Unsubscriber, type Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';
	import { WEBUI_BASE_URL } from '$lib/constants';

	import {
		chatId,
		config,
		type Model,
		models,
		tags as allTags,
		settings,
		showSidebar,
		WEBUI_NAME,
		banners,
		user,
		socket,
		audioQueue,
		showControls,
		showCallOverlay,
		temporaryChatEnabled,
		mobile,
		showOverview,
		chatTitle,
		showArtifacts,
		artifactContents,
		tools,
		toolServers,
		functions,
		selectedFolder,
		pinnedChats,
		showEmbeds
	} from '$lib/stores';
	import {
		multiChatPaneRuntime,
		multiChatPaneCommands,
		postPaneCommand
	} from '$lib/stores/multiChatPanes';
	import {
		augmentPromptWithReviewerWorkflow,
		bumpReviewerCtaImpressions,
		readReviewerCtaImpressions,
		resolveReviewerWorkflowChatState,
		REVIEWER_WORKFLOW_CTA_MAX_IMPRESSIONS
	} from '$lib/utils/reviewerWorkflow';
	import {
		buildCrossPaneRequestContext as buildCrossPaneRequestContextForRuntime,
		buildPaneRuntimeSnapshot,
		buildPrimaryDraftPayload,
		deriveComposerViewState,
		isTransientModelSelection,
		modelIdsSignature,
		paneRuntimeSignature,
		shouldApplyPaneCommand,
		type PaneCommand
	} from '$lib/utils/multiChatComposerState';
	import { portalTo } from '$lib/utils/portalAction';
	import { badgeStyleVars, ORCHESTRATOR_DISPLAY_NAME } from '$lib/utils/displayNameBadge.mjs';

	import {
		convertMessagesToHistory,
		copyToClipboard,
		getMessageContentParts,
		createMessagesList,
		getPromptVariables,
		processDetails,
		removeAllDetails,
		getCodeBlockContents,
		isYoutubeUrl
	} from '$lib/utils';
	import { revealMessageElement } from '$lib/utils/messageNavigation';
	import { AudioQueue } from '$lib/utils/audio';
	import { EXTRA_REASONING_STREAMING_MARKERS } from '$lib/utils/reasoningMarkup';

	import {
		createNewChat,
		getAllTags,
		getChatById,
		getPinnedChatList,
		getTagsById,
		updateChatById,
		updateChatFolderIdById
	} from '$lib/apis/chats';
	import { archiveChatSafely } from '$lib/apis/chatArchive.mjs';
	import { generateOpenAIChatCompletion } from '$lib/apis/openai';
	import { processWeb, processWebSearch, processYoutubeVideo } from '$lib/apis/retrieval';
	import { getAndUpdateUserLocation, getUserSettings } from '$lib/apis/users';
	import {
		chatCompleted,
		generateQueries,
		chatAction,
		generateMoACompletion,
		stopTask,
		getTaskIdsByChatId,
		getModels
	} from '$lib/apis';
	import { getTools } from '$lib/apis/tools';
	import { uploadFile } from '$lib/apis/files';
	import { createOpenAITextStream } from '$lib/apis/streaming';
	import { getFunctions } from '$lib/apis/functions';
	import { updateFolderById } from '$lib/apis/folders';
	import { normalizePromptUsage } from '$lib/config/model-pricing';
	import { getReasoningEffortOptions } from '$lib/config/model-capabilities';
	import { getEnabledModelIds, getModelAvailability } from '$lib/utils/modelAvailability';
	import { normalizeSelectedModelIds, resolveEnabledSelectedModelIds } from '$lib/utils/modelSelection';
	import { refreshChatListPageOne } from '$lib/utils/chatListPagination';
	import { buildForkedChatPayload } from '$lib/utils/chatFork';
	import {
		resolveChatNotificationModelIdentity,
		resolveNotificationModelIdentityForId,
		type ChatNotificationModelIdentity
	} from '$lib/utils/chatNotificationModel';
	import {
		getDisplayContextTokenCount,
		getDisplayTokenCountFromUsage,
		getLatestContextUsageFromHistory
	} from '$lib/utils/usage-tokens.mjs';
	import {
		createEmptyChatTurnSummary,
		deriveContextUsage,
		normalizeChatTurnSummary
	} from '$lib/utils/context-turn-summary.mjs';
	import { resolveModelMaxContextTokens } from '$lib/utils/model-context-window';
	import {
		hasOpenReasoningActivity,
		stripOpenReasoningBlocks
	} from '$lib/utils/streaming-activity.mjs';
	import {
		getDetachedWindowMode,
		hasDelegatedSubagentMetadata,
		isDelegatedSubagentRoute
	} from '$lib/utils/detached-window-mode.mjs';
	import { rebindSocketListeners } from '$lib/utils/socket-listener-binding.mjs';
	import {
		extractDetachedSubagentPayload,
		isDetachedSubagentHistoryTerminal,
		mergeDetachedSubagentCollection,
		mergeDetachedSubagentHistory,
		normalizeDetachedSubagentActiveHistory
	} from '$lib/utils/detached-subagent-reconciliation.mjs';
	import {
		normalizeSubagentToolCallDetails,
		SUBAGENT_DETAILS_CONTEXT,
		type SubagentToolCallDetails
	} from '$lib/utils/subagentDetails';
	import {
		applyDebugMonitorEventToSummary,
		buildDebugMonitorRequestUrl,
		buildDebugMonitorWebSocketUrl,
		fetchChatDebugRequests,
		fetchDebugRequestDetail,
		resolveDebugMarkerPlacement,
		resolveDebugMonitorRequestId,
		type DebugMonitorAccess,
		type DebugMonitorEvent,
		type DebugMonitorRequestSummary
	} from '$lib/utils/owuiDebugMonitor';
	import { upsertStatusHistoryEntry } from '$lib/utils/chatStatusHistory';
	import {
		reconcileRecordedToolCalls,
		recordedToolCallArraysEqual
	} from '$lib/utils/toolCallReconciliation';
	import {
		normalizeExplicitReasoningEffortByModel,
		normalizePersistedReasoningEffortByModel,
		resolveReasoningEffortByModelSnapshot,
		resolvePrimaryChatStateModelName,
		reasoningEffortByModelSignature,
		sanitizeReasoningEffortByModel,
		hasResolvedReasoningModelSelection,
		seedReasoningEffortFromParams,
		primeReasoningEffortLedger,
		removeReasoningEffortLedgerEntry,
		rebuildReasoningEffortSelectionState,
		type ReasoningEffortLedger
	} from '$lib/utils/chatReasoningState';
	// Portico (fast mode): per-chat lightning toggle helpers
	import {
		FAST_MODE_SERVICE_TIER,
		deriveServiceTierParam,
		hasGptFastModeModel,
		normalizePersistedFastMode,
		sanitizeFastModeEnabled
	} from '$lib/utils/chatFastModeState';

	// Portico: Import chat state API for persistence
	import { getChatState, saveChatState } from '$lib/apis/chatState';
	import {
		appendQueuedPrompt,
		deletePendingSteer,
		deleteQueuedPrompt,
		emptyPendingWorkState,
		getChatPendingWork,
		replacePendingSteer,
		updatePendingSteer,
		updateQueuedPrompt,
		type PendingWorkItem,
		type PendingWorkRequestContext,
		type PendingWorkState
	} from '$lib/apis/chatPendingWork';

	// Portico: Import chat capabilities API for real-time display
	import { getChatCapabilities, type ChatCapabilities } from '$lib/apis/chatCapabilities';
	import {
		getChatHydrationById,
		getChatReconciliationById,
		getSubagentDescendants
	} from '$lib/apis/chatHydration';
	import { ensureMcpServerIds } from '$lib/stores/mcpServerIds';
	import { getScopedActiveCapabilityToolIds } from '$lib/utils/chatCapabilityScope';
	import {
		deriveComposerStreamingState,
		getQueuedPromptEditTarget,
		shouldApplyPendingWorkStateSnapshot,
		shouldReconcileBackendStartedTurnEvent,
		sortQueuedPromptsForDispatch,
		type ComposerStreamingState
	} from '$lib/utils/pendingChatWork';

	import Banner from '../common/Banner.svelte';
	import MessageInput from '$lib/components/chat/MessageInput.svelte';
	import Messages from '$lib/components/chat/Messages.svelte';
	// ActivityIndicator moved to ResponseMessage.svelte
	import Navbar from '$lib/components/chat/Navbar.svelte';
	import ChatControls from './ChatControls.svelte';
	import EventConfirmDialog from '../common/ConfirmDialog.svelte';
	import Placeholder from './Placeholder.svelte';
	import LandingStarfield from './LandingStarfield.svelte';
	import NotificationToast from '../NotificationToast.svelte';
	import Spinner from '../common/Spinner.svelte';
	import Tooltip from '../common/Tooltip.svelte';
	import Sidebar from '../icons/Sidebar.svelte';
	import Image from '../common/Image.svelte';

	export let chatIdProp = '';

	// PORTICO_PATCH (multi-chat tiling): how this instance participates in the
	// tiled multi-chat view.
	// - 'single': the only chat on the page (default; all legacy behavior).
	// - 'primary': the root/orchestrator pane of a tiled view. Keeps all
	//   global-store behavior; its composer portals into the shared bottom bar
	//   and dispatches to `crossPaneTarget` when a peer pane has focus.
	// - 'tile': a peer pane. Live (streaming, confirmations) but writes NO
	//   global singletons: no global chatId/chatTitle, no navbar/controls/
	//   composer/audio, no tab-activity reporting, suffixed DOM ids.
	// An instance may flip 'single'<->'primary' (home-route tiling activation)
	// but never to/from 'tile'.
	export let paneRole: 'single' | 'primary' | 'tile' = 'single';
	export let composerPortalTarget: HTMLElement | null = null;
	export let crossPaneTarget: { chatId: string; displayName: string } | null = null;

	const isTile = paneRole === 'tile';
	$: multiChatActiveLocal = paneRole !== 'single';
	// Instance-local identity for socket filtering and pending-work routing —
	// the global chatId store cannot distinguish panes when several chats mount.
	let activeChatId = '';
	// Instance-local title (tiles must not write the global chatTitle store).
	let localPaneTitle = '';
	// Tile-mode load failure → inline error card instead of goto('/').
	let paneLoadError = false;
	const setActiveChat = (id: string) => {
		activeChatId = id ?? '';
		if (!isTile) {
			chatId.set(activeChatId);
		}
	};

	let loading = true;
	let chatLoadGeneration = 0;
	let chatLoadAbortController: AbortController | null = null;
	let chatLoadStartedAt = 0;
	let chatFirstPaintReady = false;
	let chatRichContentReady = true;
	const subagentToolCallDetails = writable<SubagentToolCallDetails>({});
	setContext(SUBAGENT_DETAILS_CONTEXT, subagentToolCallDetails);

	const isCurrentChatLoad = (generation: number, targetChatId: string): boolean =>
		generation === chatLoadGeneration && targetChatId === chatIdProp;

	const waitForAnimationFrame = () =>
		new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

	const reportChatLoadReady = async (generation: number, targetChatId: string) => {
		await waitForAnimationFrame();
		await waitForAnimationFrame();
		if (!isCurrentChatLoad(generation, targetChatId)) return;

		chatFirstPaintReady = true;
		await tick();
		if (!isCurrentChatLoad(generation, targetChatId)) return;
		const durationMs = Math.max(0, performance.now() - chatLoadStartedAt);
		const startMark = `portico:chat-load:${generation}:start`;
		const readyMark = `portico:chat-load:${generation}:ready`;
		performance.mark(readyMark);
		performance.clearMeasures('portico-chat-load-visible');
		try {
			performance.measure('portico-chat-load-visible', startMark, readyMark);
		} catch {
			// Timing marks are diagnostic only and must never block chat rendering.
		}
		performance.clearMarks(startMark);
		performance.clearMarks(readyMark);

		if (!isTile) {
			// Shell-side load detection assumes one loaded chat per tab.
			window.dispatchEvent(
				new CustomEvent('portico-chat-load-ready', {
					detail: { chatId: targetChatId, durationMs, generation }
				})
			);
		}
		window.requestAnimationFrame(() => {
			if (isCurrentChatLoad(generation, targetChatId)) {
				chatRichContentReady = true;
			}
		});
		scheduleAggregateWorkflowCostRefresh();
		scheduleContextTurnSummaryRefresh();
	};

	const eventTarget = new EventTarget();
	let controlPane;
	let controlPaneComponent;

	let messageInput;

	let autoScroll = true;
	let processing = '';
	let messagesContainerElement: HTMLDivElement;

	let navbarElement;

	let showEventConfirmation = false;
	let eventConfirmationTitle = '';
	let eventConfirmationMessage = '';
	let eventConfirmationInput = false;
	let eventConfirmationInputPlaceholder = '';
	let eventConfirmationInputValue = '';
	let eventCallback = null;

	const runTrustedExecuteAction = async (payload: Record<string, unknown>) => {
		const action = typeof payload?.action === 'string' ? payload.action : '';

		switch (action) {
			case 'copy_to_clipboard': {
				const value = typeof payload?.value === 'string' ? payload.value : '';
				await copyToClipboard(value);
				return { success: true };
			}
			default:
				throw new Error(`Unsupported execute action: ${action || 'unknown'}`);
		}
	};

	let chatIdUnsubscriber: Unsubscriber | undefined;

	let selectedModels = [''];
	let atSelectedModel: Model | undefined;
	let selectedModelIds = [];
	let urlSelectedModelResolutionFailed = false;
	$: if (atSelectedModel !== undefined) {
		selectedModelIds = [atSelectedModel.id];
	} else {
		selectedModelIds = selectedModels;
	}
	let routeDelegatedSubagentView = false;
	let hydratedDelegatedSubagentView = false;
	let delegatedSubagentView = false;
	let chatNavigationGeneration = 0;
	beforeNavigate(() => {
		chatNavigationGeneration += 1;
	});
	$: routeDelegatedSubagentView = isDelegatedSubagentRoute($page.url.searchParams);
	$: delegatedSubagentView = routeDelegatedSubagentView || hydratedDelegatedSubagentView;
	type DetachedSubagentStatus = 'loading' | 'ready' | 'pending' | 'error';
	let detachedSubagentLoadError = false;
	let detachedSubagentStatus: DetachedSubagentStatus = 'loading';
	let detachedSubagentStatusMessage = 'Loading subagent details...';

	const getDetachedSubagentStatusMessage = (status: DetachedSubagentStatus) => {
		if (status === 'pending') {
			return 'This subagent chat is still being prepared.';
		}
		if (status === 'error') {
			return 'This subagent chat could not be loaded.';
		}
		return 'Loading subagent details...';
	};

	const setDetachedSubagentStatus = (
		status: DetachedSubagentStatus,
		message = getDetachedSubagentStatusMessage(status)
	) => {
		detachedSubagentStatus = status;
		detachedSubagentStatusMessage = message;
		detachedSubagentLoadError = status === 'error';
	};

	const ensureComposerChatId = async () => {
		if (isTile) {
			// Tiles render no composer; nothing should mint ids from them.
			return String(activeChatId || chatIdProp || '').trim();
		}
		const existingChatId = String(get(chatId) || chatIdProp || '').trim();
		if (existingChatId) {
			return existingChatId;
		}

		const nextChatId =
			$temporaryChatEnabled === true ? `local:${$socket?.id || uuidv4()}` : uuidv4();
		setActiveChat(nextChatId);
		return nextChatId;
	};

	const movePendingWorkspaceSelection = async (fromChatId: string, toChatId: string) => {
		const normalizedFromChatId = String(fromChatId || '').trim();
		const normalizedToChatId = String(toChatId || '').trim();
		if (
			!normalizedFromChatId ||
			!normalizedToChatId ||
			normalizedFromChatId === normalizedToChatId
		) {
			return;
		}

		const hostApi = browser ? (window as any)?.webviewHost : null;
		if (!hostApi?.moveChatWorkspaceSelection) {
			return;
		}

		const result = await hostApi.moveChatWorkspaceSelection(
			normalizedFromChatId,
			normalizedToChatId
		);
		if (!result?.success) {
			throw new Error(result?.error || 'Failed to apply selected workspace folder');
		}
	};

	const reconcileWorkspaceVmsBeforeExecution = async (targetChatId: string) => {
		const normalizedChatId = String(targetChatId || '').trim();
		if (!normalizedChatId || normalizedChatId.startsWith('local:')) {
			return;
		}

		const hostApi = browser ? (window as any)?.webviewHost : null;
		if (!hostApi?.reconcileChatWorkspaceVms) {
			return;
		}

		const result = await hostApi.reconcileChatWorkspaceVms(normalizedChatId);
		if (!result?.success) {
			throw new Error(result?.error || 'Failed to apply selected workspace folder');
		}
	};

	let selectedToolIds = [];
	let selectedFilterIds = [];
	let imageGenerationEnabled = false;
	let webSearchEnabled = false;
	let codeInterpreterEnabled = false;
	let debugModeEnabled = false;
	let debugMonitorRequestsById: Record<string, DebugMonitorRequestSummary> = {};
	let debugMarkersAfterMessageId: Record<string, DebugMonitorRequestSummary[]> = {};
	let debugMarkersAfterToolBlockByMessageId: Record<
		string,
		Record<number, DebugMonitorRequestSummary[]>
	> = {};
	let debugBackgroundMarkers: DebugMonitorRequestSummary[] = [];
	let debugMonitorSocket: WebSocket | null = null;
	let debugMonitorSocketChatId = '';
	let debugMonitorSyncVersion = 0;
	let activeDebugMonitorChatId = '';
	let debugMonitorAccess: DebugMonitorAccess | null = null;

	// Portico: Per-chat reasoning effort state.
	// Uses model-index keys ('0', '1', ...) so duplicate selected models are supported.
	let reasoningEffortByModel: Record<string, string> = {};
	let reasoningEffortReady = false;
	let reasoningEffortPersistedSignature = reasoningEffortByModelSignature(reasoningEffortByModel);
	// Session ledger keying the same values by MODEL ID, so switching agents
	// re-seeds the slot from the new agent's configured effort instead of
	// inheriting the previous agent's value (see chatReasoningState.ts).
	let reasoningEffortLedger: ReasoningEffortLedger = {};

	// Portico (fast mode): per-chat lightning toggle. GPT models only; drives
	// the composer's static purple treatment and the outbound service_tier param.
	// Persisted via chat-state and mirrored into session drafts.
	let fastModeEnabled = false;
	let fastModePersistedValue: boolean | null = null;

	// PORTICO (reviewer workflow): per-chat toggle. Armed (editable) only before
	// a chat's FIRST prompt — new chats ALWAYS start off (an augmented prompt
	// is an explicit per-chat opt-in, never a remembered default); the first
	// send locks it read-only and the decision persists on the chat record
	// (reviewer_workflow, written by saveChatHandler). Children of a
	// multi-chat root inherit the root's locked state.
	let reviewerWorkflowEnabledLocal = false;
	let reviewerWorkflowLocked = false;

	const handleReviewerWorkflowToggle = (next: boolean) => {
		if (reviewerWorkflowLocked) return;
		reviewerWorkflowEnabledLocal = next === true;
		// Interacting with the pill means the callout did its job — hide it for
		// this view (the impression budget still governs future landings).
		reviewerCtaDismissed = true;
	};

	// EVERY user-prompt entry path (composer, landing placeholder, suggestion
	// cards, ?q= deep links, window-message submits) must consume the arming
	// through this ONE helper: it augments when armed and locks the per-chat
	// decision at the first send. Idempotent afterwards (locked ⇒ passthrough).
	const consumeReviewerWorkflowArming = (userPrompt: string): string => {
		const armed = !reviewerWorkflowLocked && reviewerWorkflowEnabledLocal;
		reviewerWorkflowLocked = true;
		return armed ? augmentPromptWithReviewerWorkflow(userPrompt) : userPrompt;
	};

	// CTA callout: landing page only, at most 3 impressions per user — the
	// host-persisted count is the ONLY budget retirement (an impression counts
	// even when the user toggles the pill; people click things without
	// reading). Hidden for the current view by the callout's X or by toggling
	// the pill, and footered with how many displays remain.
	let reviewerCtaImpressionsOk = false;
	let reviewerCtaCounted = false;
	let reviewerCtaDismissed = false;
	let reviewerCtaRemaining = REVIEWER_WORKFLOW_CTA_MAX_IMPRESSIONS - 1;
	$: reviewerCtaVisible =
		showLandingPlaceholder && reviewerCtaImpressionsOk && !reviewerCtaDismissed;
	$: if (reviewerCtaVisible && !reviewerCtaCounted) {
		reviewerCtaCounted = true;
		void bumpReviewerCtaImpressions(getWebviewHostApi()).then((impressions) => {
			if (typeof impressions === 'number') {
				reviewerCtaRemaining = Math.max(
					0,
					REVIEWER_WORKFLOW_CTA_MAX_IMPRESSIONS - impressions
				);
			}
		});
	}
	const dismissReviewerCta = () => {
		reviewerCtaDismissed = true;
	};

	// Portico: Active capabilities state for real-time display
	let activeCapabilities: ChatCapabilities = { tools: [], skills: [] };
	let activeCapabilitiesChatId = '';

	const applyActiveCapabilities = (
		nextCapabilities: ChatCapabilities | null | undefined,
		sourceChatId: string | null | undefined
	) => {
		activeCapabilities = {
			tools: nextCapabilities?.tools ?? [],
			skills: nextCapabilities?.skills ?? []
		};
		activeCapabilitiesChatId =
			typeof sourceChatId === 'string' ? sourceChatId.trim() : '';

		const serverIds = (activeCapabilities.tools ?? [])
			.map((tool) => (typeof tool?.server_id === 'string' ? tool.server_id.trim() : ''))
			.filter((serverId) => serverId.length > 0);
		if (serverIds.length > 0) {
			void ensureMcpServerIds(serverIds);
		}
	};

	const clearActiveCapabilities = () => {
		applyActiveCapabilities({ tools: [], skills: [] }, '');
	};

	const getActiveCapabilityToolIdsForRequest = (
		requestChatId: string | null | undefined
	): string[] =>
		getScopedActiveCapabilityToolIds({
			activeCapabilities,
			requestChatId,
			activeCapabilitiesChatId
		});

	// Portico: Context token tracking from the newest measured assistant usage payload.
	// Cache read/write counters are cost/accounting metadata and should not be added on top of
	// the model-reported prompt/total token counts for context window display.
	let persistedContextTokens = 0;
	let persistedMaxContextTokens = 0;
	let contextTokensVersion = 0;
	const bumpContextTokensVersion = () => {
		contextTokensVersion += 1;
	};

	const setReasoningEffortState = ({
		nextMap,
		ready,
		markPersisted = false
	}: {
		nextMap: Record<string, string>;
		ready?: boolean;
		markPersisted?: boolean;
	}) => {
		const sanitizedMap = sanitizeReasoningEffortByModel(nextMap);
		reasoningEffortByModel = sanitizedMap;
		if (ready !== undefined) {
			reasoningEffortReady = ready;
		}
		if (markPersisted) {
			reasoningEffortPersistedSignature = reasoningEffortByModelSignature(sanitizedMap);
		}
	};

	const resetReasoningEffortState = ({ ready }: { ready: boolean }) => {
		reasoningEffortLedger = {};
		setReasoningEffortState({
			nextMap: {},
			ready,
			markPersisted: true
		});
	};

	const getAllowedReasoningEffortOptionsForModel = (model: Model | undefined): string[] | null => {
		if (!model?.name) {
			return null;
		}

		let lookupName = model.name;
		const baseModelId = model.info?.base_model_id;
		if (baseModelId) {
			const baseModel = $models.find((item) => item.id === baseModelId);
			if (baseModel?.name) {
				lookupName = baseModel.name;
			}
		}

		return getReasoningEffortOptions(lookupName);
	};

	const getAllowedReasoningEffortOptionsByModelIndex = (
		modelIds: string[] | null | undefined
	): Record<string, string[]> =>
		Object.fromEntries(
			(modelIds ?? [])
				.map((modelId, index) => {
					const model = $models.find((item) => item.id === modelId);
					const allowedOptions = getAllowedReasoningEffortOptionsForModel(model);
					return allowedOptions && allowedOptions.length > 0
						? ([String(index), allowedOptions] as const)
						: null;
				})
				.filter(Boolean)
		);

	const getAllowedReasoningEffortOptionsByModelId = (
		modelIds: string[] | null | undefined
	): Record<string, string[]> =>
		Object.fromEntries(
			(modelIds ?? [])
				.map((modelId) => {
					const model = $models.find((item) => item.id === modelId);
					const allowedOptions = getAllowedReasoningEffortOptionsForModel(model);
					return allowedOptions && allowedOptions.length > 0
						? ([modelId, allowedOptions] as const)
						: null;
				})
				.filter(Boolean)
		);

	// A selected AGENT's configured reasoning effort
	// (model.info.meta.subagent_reasoning_effort), keyed by model id.
	const getConfiguredAgentReasoningEffortByModelId = (
		modelIds: string[] | null | undefined
	): Record<string, string> =>
		Object.fromEntries(
			(modelIds ?? [])
				.map((modelId) => {
					const model = $models.find((item) => item.id === modelId);
					const configured =
						model?.info?.meta?.subagent_reasoning_effort ??
						(model as any)?.meta?.subagent_reasoning_effort;
					const effort = typeof configured === 'string' ? configured.trim() : '';
					return effort ? ([modelId, effort] as const) : null;
				})
				.filter(Boolean)
		);

	const normalizeExplicitReasoningEffortStateForModelIds = ({
		reasoningEffortByModel: nextReasoningEffortByModel,
		modelIds = selectedModelIds
	}: {
		reasoningEffortByModel: unknown;
		modelIds?: string[] | null | undefined;
	}): Record<string, string> =>
		normalizeExplicitReasoningEffortByModel({
			reasoningEffortByModel: nextReasoningEffortByModel,
			allowedOptionsByModelIndex: getAllowedReasoningEffortOptionsByModelIndex(modelIds),
			selectedModelCount: Array.isArray(modelIds) ? modelIds.length : 0
		});

	const getResolvedReasoningEffortByModelSnapshotFromState = ({
		reasoningEffortByModel: nextReasoningEffortByModel,
		modelIds = selectedModelIds
	}: {
		reasoningEffortByModel: unknown;
		modelIds?: string[] | null | undefined;
	}): Record<string, string> =>
		resolveReasoningEffortByModelSnapshot({
			reasoningEffortByModel: nextReasoningEffortByModel,
			allowedOptionsByModelIndex: getAllowedReasoningEffortOptionsByModelIndex(modelIds)
		});

	const getResolvedReasoningEffortByModelSnapshot = (
		modelIds: string[] | null | undefined = selectedModelIds
	): Record<string, string> =>
		getResolvedReasoningEffortByModelSnapshotFromState({
			reasoningEffortByModel,
			modelIds
		});

	const applyPersistedChatState = (persistedState: Record<string, any> | null) => {
		if (!persistedState) {
			persistedContextTokens = 0;
			persistedMaxContextTokens = 0;
			fastModeEnabled = false;
			fastModePersistedValue = null;
			setReasoningEffortState({
				nextMap: {},
				markPersisted: true
			});
			seedReasoningEffortGapsFromChatParams();
			return;
		}

		fastModeEnabled = normalizePersistedFastMode(persistedState);
		fastModePersistedValue = fastModeEnabled;

		persistedContextTokens =
			typeof persistedState.context_tokens === 'number'
				? Math.max(0, Math.floor(persistedState.context_tokens))
				: 0;
		persistedMaxContextTokens =
			typeof persistedState.max_context_tokens === 'number'
				? Math.max(0, Math.floor(persistedState.max_context_tokens))
				: 0;

		const persistedReasoningEffortByModel = normalizePersistedReasoningEffortByModel({
			persistedState,
			selectedModelIds: selectedModels
		});
		// The persisted map belongs to THIS chat's selection: remember which
		// model each value was saved for, so a later agent switch re-seeds while
		// switching back restores it.
		reasoningEffortLedger = primeReasoningEffortLedger({
			ledger: reasoningEffortLedger,
			modelIds: selectedModels,
			reasoningEffortByModel: persistedReasoningEffortByModel
		});
		setReasoningEffortState({
			nextMap: persistedReasoningEffortByModel,
			markPersisted: true
		});
		seedReasoningEffortGapsFromChatParams();
	};

	// Persisted picker choices always win, but a chat record that carries a
	// launch effort (delegated subagent chats, workflow-started peer chats via
	// start_chat, or Controls-set params) must not fall back to the model
	// default just because the chat-state service has no snapshot for it —
	// applyPersistedChatState replaces the whole map, so gap-fill AFTER every
	// application (the seed helper only fills missing entries).
	const seedReasoningEffortGapsFromChatParams = () => {
		if (typeof params?.reasoning_effort === 'string') {
			seedReasoningEffortFromChatParams();
		}
	};

	const refreshPersistedChatState = async (chatId: string) => {
		if (!chatId) {
			applyPersistedChatState(null);
			reasoningEffortReady = true;
			return null;
		}

		const persistedState = await getChatState(chatId);
		applyPersistedChatState(persistedState as Record<string, any> | null);
		reasoningEffortReady = true;
		return persistedState;
	};

	const applyDraftInput = (input: Record<string, any>) => {
		if ($temporaryChatEnabled) {
			return;
		}

		messageInput?.setText(input.prompt);
		files = input.files;
		selectedToolIds = input.selectedToolIds;
		selectedFilterIds = input.selectedFilterIds;
		webSearchEnabled = input.webSearchEnabled;
		imageGenerationEnabled = input.imageGenerationEnabled;
		codeInterpreterEnabled = input.codeInterpreterEnabled;

		if ('reasoningEffortByModel' in input) {
			const draftReasoningEffortByModel = sanitizeReasoningEffortByModel(
				input.reasoningEffortByModel
			);
			// Drafts save the map for the selection they were taken from.
			reasoningEffortLedger = primeReasoningEffortLedger({
				ledger: reasoningEffortLedger,
				modelIds: selectedModels,
				reasoningEffortByModel: draftReasoningEffortByModel
			});
			setReasoningEffortState({
				nextMap: draftReasoningEffortByModel
			});
		}

		if ('fastModeEnabled' in input) {
			fastModeEnabled = sanitizeFastModeEnabled(input.fastModeEnabled);
		}
	};

	const buildDraftInput = ({
		nextReasoningEffortByModel = reasoningEffortByModel
	}: {
		nextReasoningEffortByModel?: Record<string, string>;
	} = {}) => ({
		prompt,
		files: files
			.filter((file) => file.type !== 'image')
			.map((file) => ({
				...file,
				user: undefined,
				access_control: undefined
			})),
		selectedToolIds,
		selectedFilterIds,
		imageGenerationEnabled,
		webSearchEnabled,
		codeInterpreterEnabled,
		reasoningEffortByModel: sanitizeReasoningEffortByModel(nextReasoningEffortByModel),
		fastModeEnabled
	});

	const persistReasoningEffortSnapshot = ({
		chatId,
		modelIds = selectedModelIds,
		reasoningEffortByModelSnapshot
	}: {
		chatId: string | null | undefined;
		modelIds?: string[] | null | undefined;
		reasoningEffortByModelSnapshot: Record<string, string>;
	}) => {
		if (!chatId || delegatedSubagentView || $temporaryChatEnabled) {
			return;
		}

		const nextReasoningEffortSignature =
			reasoningEffortByModelSignature(reasoningEffortByModelSnapshot);
		if (nextReasoningEffortSignature === reasoningEffortPersistedSignature) {
			return;
		}

		reasoningEffortPersistedSignature = nextReasoningEffortSignature;
		fastModePersistedValue = fastModeEnabled;
		void saveChatState(chatId, {
			context_tokens: contextTokens,
			max_context_tokens: resolveModelMaxContextTokens($models ?? [], modelIds ?? []),
			reasoning_effort_by_model: reasoningEffortByModelSnapshot,
			fast_mode: fastModeEnabled,
			model_name: resolvePrimaryChatStateModelName({
				modelIds,
				models: $models ?? []
			})
		});
	};

	const handleReasoningEffortSelection = ({
		modelIndex,
		value
	}: {
		modelIndex: number | string;
		value: string;
	}) => {
		const nextReasoningEffortByModel = sanitizeReasoningEffortByModel(reasoningEffortByModel);
		const normalizedModelIndex = String(modelIndex).trim();
		const normalizedValue = typeof value === 'string' ? value.trim() : '';

		if (!normalizedModelIndex) {
			return;
		}

		if (normalizedValue) {
			nextReasoningEffortByModel[normalizedModelIndex] = normalizedValue;
		} else {
			delete nextReasoningEffortByModel[normalizedModelIndex];
		}

		// Record the choice against the model actually at this slot so it
		// survives agent switches away and back.
		const targetModelId = Array.isArray(selectedModelIds)
			? selectedModelIds[Number(normalizedModelIndex)]
			: undefined;
		if (targetModelId) {
			reasoningEffortLedger = normalizedValue
				? primeReasoningEffortLedger({
						ledger: reasoningEffortLedger,
						modelIds: [targetModelId],
						reasoningEffortByModel: { '0': normalizedValue },
						explicit: true
					})
				: removeReasoningEffortLedgerEntry(reasoningEffortLedger, targetModelId);
		}

		const normalizedExplicitReasoningEffortByModel =
			normalizeExplicitReasoningEffortStateForModelIds({
				reasoningEffortByModel: nextReasoningEffortByModel
			});
		const nextReasoningEffortSignature = reasoningEffortByModelSignature(
			normalizedExplicitReasoningEffortByModel
		);
		if (nextReasoningEffortSignature === reasoningEffortByModelSignature(reasoningEffortByModel)) {
			return;
		}

		setReasoningEffortState({
			nextMap: normalizedExplicitReasoningEffortByModel
		});

		if (!$temporaryChatEnabled) {
			void saveDraftImmediately(
				buildDraftInput({
					nextReasoningEffortByModel: normalizedExplicitReasoningEffortByModel
				}),
				activeChatId || null
			);
		}

		persistReasoningEffortSnapshot({
			chatId: activeChatId,
			reasoningEffortByModelSnapshot: getResolvedReasoningEffortByModelSnapshotFromState({
				reasoningEffortByModel: normalizedExplicitReasoningEffortByModel
			})
		});
	};

	// Portico (fast mode): persist the lightning toggle per chat. Skipped for
	// delegated and temporary chats, mirroring the reasoning-effort rules.
	const persistFastModeSnapshot = (chatIdArg: string | null | undefined) => {
		if (!chatIdArg || delegatedSubagentView || $temporaryChatEnabled) {
			return;
		}
		if (fastModePersistedValue === fastModeEnabled) {
			return;
		}
		fastModePersistedValue = fastModeEnabled;
		void saveChatState(chatIdArg, {
			context_tokens: contextTokens,
			max_context_tokens: resolveModelMaxContextTokens($models ?? [], selectedModelIds ?? []),
			reasoning_effort_by_model: getResolvedReasoningEffortByModelSnapshotFromState({
				reasoningEffortByModel
			}),
			fast_mode: fastModeEnabled,
			model_name: resolvePrimaryChatStateModelName({
				modelIds: selectedModelIds,
				models: $models ?? []
			})
		});
	};

	const handleFastModeToggle = (next: boolean) => {
		fastModeEnabled = next === true;
		if (!$temporaryChatEnabled) {
			void saveDraftImmediately(buildDraftInput(), activeChatId || null);
		}
		persistFastModeSnapshot(activeChatId);
	};

	const parseUsageCostValue = (value: unknown): number => {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}

		if (typeof value === 'string') {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}

		return 0;
	};

	const roundUsageCost = (value: number): number => {
		if (!Number.isFinite(value)) {
			return 0;
		}

		return Math.round(value * 1_000_000) / 1_000_000;
	};

	const parseUsageInteger = (value: unknown): number => {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return Math.trunc(value);
		}

		if (typeof value === 'string') {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return Math.trunc(parsed);
			}
		}

		return 0;
	};

	const getPromptTokenDetails = (
		usage: Record<string, unknown> | undefined
	): Record<string, unknown> => {
		const details = usage?.prompt_tokens_details;
		return details && typeof details === "object" ? (details as Record<string, unknown>) : {};
	};

	const mergePromptTokenDetails = (
		currentUsage: Record<string, unknown> | undefined,
		nextUsage: Record<string, unknown> | undefined,
		mode: 'sum' | 'max'
	): Record<string, unknown> => {
		const currentDetails = getPromptTokenDetails(currentUsage);
		const nextDetails = getPromptTokenDetails(nextUsage);
		const mergedDetails: Record<string, unknown> = { ...currentDetails };
		const numericDetailKeys = new Set(['cached_tokens', 'cache_creation_tokens', 'cache_read_tokens']);

		for (const [key, value] of Object.entries(nextDetails)) {
			if (numericDetailKeys.has(key)) {
				const currentValue = parseUsageInteger(mergedDetails[key]);
				const nextValue = parseUsageInteger(value);
				const mergedValue =
					mode === 'sum' ? currentValue + nextValue : Math.max(currentValue, nextValue);
				if (mergedValue > 0) {
					mergedDetails[key] = mergedValue;
				}
			} else {
				mergedDetails[key] = value;
			}
		}

		return mergedDetails;
	};

	const mergePromptUsage = (
		currentUsage: Record<string, unknown> | undefined,
		nextUsage: Record<string, unknown> | undefined,
		mode: 'sum' | 'max'
	): Record<string, unknown> => {
		const currentNormalized = normalizePromptUsage(currentUsage);
		const nextNormalized = normalizePromptUsage(nextUsage);

		const currentTotalTokens =
			currentNormalized.totalTokens || currentNormalized.promptTokens + currentNormalized.completionTokens;
		const nextTotalTokens =
			nextNormalized.totalTokens || nextNormalized.promptTokens + nextNormalized.completionTokens;

		const promptTokens =
			mode === 'sum'
				? currentNormalized.promptTokens + nextNormalized.promptTokens
				: Math.max(currentNormalized.promptTokens, nextNormalized.promptTokens);
		const completionTokens =
			mode === 'sum'
				? currentNormalized.completionTokens + nextNormalized.completionTokens
				: Math.max(currentNormalized.completionTokens, nextNormalized.completionTokens);
		const totalTokens =
			mode === 'sum'
				? currentTotalTokens + nextTotalTokens
				: Math.max(currentTotalTokens, nextTotalTokens, promptTokens + completionTokens);
		const cachedTokens =
			mode === 'sum'
				? currentNormalized.cachedTokens + nextNormalized.cachedTokens
				: Math.max(currentNormalized.cachedTokens, nextNormalized.cachedTokens);
		const cacheReadInputTokens =
			mode === 'sum'
				? currentNormalized.cacheReadInputTokens + nextNormalized.cacheReadInputTokens
				: Math.max(
						currentNormalized.cacheReadInputTokens,
						nextNormalized.cacheReadInputTokens
					);
		const cacheCreationInputTokens =
			mode === 'sum'
				? currentNormalized.cacheCreationInputTokens + nextNormalized.cacheCreationInputTokens
				: Math.max(
						currentNormalized.cacheCreationInputTokens,
						nextNormalized.cacheCreationInputTokens
					);
		const cacheWriteInputTokens =
			mode === 'sum'
				? currentNormalized.cacheWriteInputTokens + nextNormalized.cacheWriteInputTokens
				: Math.max(currentNormalized.cacheWriteInputTokens, nextNormalized.cacheWriteInputTokens);
		const cost =
			mode === 'sum'
				? roundUsageCost(
						parseUsageCostValue(currentUsage?.cost) + parseUsageCostValue(nextUsage?.cost)
					)
				: Math.max(parseUsageCostValue(currentUsage?.cost), parseUsageCostValue(nextUsage?.cost));

		const mergedUsage: Record<string, unknown> = {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: totalTokens
		};

		if (cachedTokens > 0) {
			mergedUsage.cached_tokens = cachedTokens;
		}
		if (cacheReadInputTokens > 0) {
			mergedUsage.cache_read_input_tokens = cacheReadInputTokens;
		}
		if (cacheCreationInputTokens > 0) {
			mergedUsage.cache_creation_input_tokens = cacheCreationInputTokens;
		}
		if (cacheWriteInputTokens > 0) {
			mergedUsage.cache_write_input_tokens = cacheWriteInputTokens;
		}
		if (cost > 0) {
			mergedUsage.cost = cost;
		}

		const mergedDetails = mergePromptTokenDetails(currentUsage, nextUsage, mode);
		if (Object.keys(mergedDetails).length > 0) {
			mergedUsage.prompt_tokens_details = mergedDetails;
		}

		// ULTRA multi-agent usage: context_tokens is the LAST round's
		// occupancy — a latest-value, not a peak or a sum. The newer payload
		// wins whenever it carries the field; otherwise the previous value
		// survives the merge.
		const nextContextTokens = parseUsageInteger(nextUsage?.context_tokens);
		const contextTokens =
			nextContextTokens > 0 ? nextContextTokens : parseUsageInteger(currentUsage?.context_tokens);
		if (contextTokens > 0) {
			mergedUsage.context_tokens = contextTokens;
		}

		return mergedUsage;
	};

	const reportPromptCostCompletion = async (
		chatId: string,
		modelId: string,
		responseMessageId: string,
		fallbackMessage: Record<string, unknown> | null = null
	) => {
		void chatId;
		void modelId;
		void responseMessageId;
		void fallbackMessage;
	};

	const normalizeUsageForComparison = (usage: Record<string, unknown> | undefined) => {
		const normalizedUsage = normalizePromptUsage(usage);

		return {
			prompt_tokens: normalizedUsage.promptTokens,
			completion_tokens: normalizedUsage.completionTokens,
			total_tokens: normalizedUsage.totalTokens,
			cost: parseUsageCostValue(usage?.['cost']),
			cached_tokens: normalizedUsage.cachedTokens,
			cache_read_input_tokens: normalizedUsage.cacheReadInputTokens,
			cache_creation_input_tokens: normalizedUsage.cacheCreationInputTokens,
			cache_write_input_tokens: normalizedUsage.cacheWriteInputTokens
		};
	};

	const hasMeaningfulUsageChange = (
		currentUsage: Record<string, unknown> | undefined,
		nextUsage: Record<string, unknown> | undefined
	): boolean => {
		const current = normalizeUsageForComparison(currentUsage);
		const next = normalizeUsageForComparison(nextUsage);

		return (
			current.prompt_tokens !== next.prompt_tokens ||
			current.completion_tokens !== next.completion_tokens ||
			current.total_tokens !== next.total_tokens ||
			current.cost !== next.cost ||
			current.cached_tokens !== next.cached_tokens ||
			current.cache_read_input_tokens !== next.cache_read_input_tokens ||
			current.cache_creation_input_tokens !== next.cache_creation_input_tokens ||
			current.cache_write_input_tokens !== next.cache_write_input_tokens
		);
	};

	type ChatCostMetrics = {
		cost: number;
		costWithoutCache: number;
		cacheSavings: number;
		savingsRate: number;
		cachedTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};

	type ChatTurnSummary = {
		promptTokens: number;
		contextTokens: number;
		requestCount: number;
	};
	type WebviewHostApi = {
		getChatCostSummary?: (options?: { chatIds?: string[] }) => Promise<{
			success?: boolean;
			data?: {
				summary?: Record<string, unknown>;
			};
		}>;
		getChatTurnSummary?: (options?: {
			chatId?: string;
			messageId?: string;
		}) => Promise<{
			success?: boolean;
			data?: {
				summary?: Record<string, unknown>;
			};
		}>;
		getDebugMode?: () => Promise<boolean>;
		getDebugMonitorAccess?: () => Promise<DebugMonitorAccess>;
		openDebugMonitorLink?: (url: string) => Promise<{
			success?: boolean;
			error?: string;
		}>;
	};

	const SUBAGENT_COST_CACHE_TTL_MS = 30_000;
	const SUBAGENT_COST_REFRESH_DEBOUNCE_MS = 180;

	const createEmptyChatCostMetrics = (): ChatCostMetrics => ({
		cost: 0,
		costWithoutCache: 0,
		cacheSavings: 0,
		savingsRate: 0,
		cachedTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0
	});

	// createEmptyChatTurnSummary / normalizeChatTurnSummary / deriveContextUsage
	// live in $lib/utils/context-turn-summary.mjs so their behavior is unit
	// testable without pinning this component's source.

	const normalizeChatIdValue = (value: unknown): string | null => {
		const chatId = String(value ?? '').trim();
		if (!chatId || chatId.startsWith('local:')) {
			return null;
		}
		return chatId;
	};

	const getLatestAssistantMessageId = (
		messages: Record<string, any> | undefined,
		currentMessageId: string | null | undefined
	): string | null => {
		if (!messages || !currentMessageId) {
			return null;
		}

		let activeMessageId: string | null | undefined = currentMessageId;
		while (activeMessageId) {
			const message = messages[activeMessageId];
			if (message?.role === 'assistant') {
				return activeMessageId;
			}
			activeMessageId = message?.parentId;
		}

		return null;
	};

	const getWebviewHostApi = (): WebviewHostApi | undefined => {
		if (!browser || typeof window === 'undefined') {
			return undefined;
		}
		return (window as any)?.webviewHost as WebviewHostApi | undefined;
	};

	const DEBUG_MONITOR_EVENT_TYPES = new Set([
		'llm_request_start',
		'llm_request_payload',
		'llm_request_transformed',
		'llm_response_complete',
		'error'
	]);

	const clearDebugMonitorState = () => {
		debugMonitorRequestsById = {};
		debugMarkersAfterMessageId = {};
		debugMarkersAfterToolBlockByMessageId = {};
		debugBackgroundMarkers = [];
	};

	const closeDebugMonitorSocket = () => {
		if (debugMonitorSocket) {
			debugMonitorSocket.onopen = null;
			debugMonitorSocket.onmessage = null;
			debugMonitorSocket.onerror = null;
			debugMonitorSocket.onclose = null;
			debugMonitorSocket.close();
			debugMonitorSocket = null;
		}
		debugMonitorSocketChatId = '';
	};

	const resolveDebugMonitorAccess = async (): Promise<DebugMonitorAccess> => {
		if (debugMonitorAccess?.token) {
			return debugMonitorAccess;
		}
		const access = await getWebviewHostApi()?.getDebugMonitorAccess?.();
		debugMonitorAccess = {
			baseUrl: typeof access?.baseUrl === 'string' ? access.baseUrl : undefined,
			token: typeof access?.token === 'string' ? access.token : undefined
		};
		return debugMonitorAccess;
	};

	const resolveDebugModeEnabled = (value: unknown): boolean => {
		if (typeof value === 'boolean') {
			return value;
		}
		if (value && typeof value === 'object' && 'enabled' in value) {
			return Boolean((value as { enabled?: unknown }).enabled);
		}
		return false;
	};

	const applyDebugModeEnabled = (enabled: boolean) => {
		debugModeEnabled = enabled;
		if (!enabled) {
			debugMonitorSyncVersion += 1;
			closeDebugMonitorSocket();
			clearDebugMonitorState();
			debugMonitorAccess = null;
		}
	};

	const isDebugMonitorRequestEvent = (event: unknown): event is DebugMonitorEvent => {
		if (!event || typeof event !== 'object') {
			return false;
		}
		const eventType = (event as DebugMonitorEvent).event_type;
		return typeof eventType === 'string' && DEBUG_MONITOR_EVENT_TYPES.has(eventType);
	};

	const upsertDebugMonitorSummary = (event: DebugMonitorEvent) => {
		const requestId = resolveDebugMonitorRequestId(event);
		if (!requestId) {
			return;
		}

		const existing = debugMonitorRequestsById[requestId];
		const next = applyDebugMonitorEventToSummary(existing, event);
		debugMonitorRequestsById = {
			...debugMonitorRequestsById,
			[requestId]: next
		};
	};

	const attachDebugMonitorSocket = (chatId: string, access?: DebugMonitorAccess) => {
		if (!debugModeEnabled || !chatId) {
			closeDebugMonitorSocket();
			return;
		}
		if (debugMonitorSocket && debugMonitorSocketChatId === chatId) {
			return;
		}

		closeDebugMonitorSocket();

		try {
			const socket = new WebSocket(buildDebugMonitorWebSocketUrl({ chatId, access }));
			debugMonitorSocket = socket;
			debugMonitorSocketChatId = chatId;
			socket.onmessage = (messageEvent) => {
				try {
					const payload = JSON.parse(messageEvent.data);
					if (!isDebugMonitorRequestEvent(payload)) {
						return;
					}
					upsertDebugMonitorSummary(payload);
				} catch (error) {
					console.warn('[Chat] Failed to parse debug monitor event:', error);
				}
			};
			socket.onclose = () => {
				if (debugMonitorSocket === socket) {
					debugMonitorSocket = null;
					debugMonitorSocketChatId = '';
				}
			};
			socket.onerror = (error) => {
				console.warn('[Chat] Debug monitor websocket error:', error);
			};
		} catch (error) {
			console.warn('[Chat] Failed to connect debug monitor websocket:', error);
			closeDebugMonitorSocket();
		}
	};

	const syncDebugMonitorRequests = async (chatId: string) => {
		const syncVersion = ++debugMonitorSyncVersion;
		if (!debugModeEnabled || !chatId) {
			closeDebugMonitorSocket();
			clearDebugMonitorState();
			return;
		}

		try {
			const access = await resolveDebugMonitorAccess();
			const requests = await fetchChatDebugRequests(chatId, access);
			if (syncVersion !== debugMonitorSyncVersion || !debugModeEnabled) {
				return;
			}
			debugMonitorRequestsById = Object.fromEntries(
				requests.map((request) => [request.request_id, request])
			);
			attachDebugMonitorSocket(chatId, access);
		} catch (error) {
			if (syncVersion !== debugMonitorSyncVersion || !debugModeEnabled) {
				return;
			}
			console.warn('[Chat] Failed to hydrate debug monitor requests:', error);
			clearDebugMonitorState();
			closeDebugMonitorSocket();
		}
	};

	const handleDebugModeChanged = (event: Event) => {
		const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
		applyDebugModeEnabled(Boolean(detail?.enabled));
	};

	const KONAMI_UNLOCK_MODEL_ID = 'GPT-5.6 Sol Pro';

	const isKonamiUnlockModel = (model: Model | null | undefined): boolean => {
		const modelId = `${model?.id ?? ''}`.trim();
		return modelId === KONAMI_UNLOCK_MODEL_ID || modelId === `${KONAMI_UNLOCK_MODEL_ID}:latest`;
	};

	const clearKonamiModelDisabledState = (model: Model): Model => {
		const nextMeta =
			model?.meta && typeof model.meta === 'object' ? { ...model.meta } : {};
		nextMeta.disabled = false;
		delete nextMeta.disabled_reason;

		const nextInfoMeta =
			model?.info?.meta && typeof model.info.meta === 'object'
				? { ...model.info.meta }
				: undefined;
		if (nextInfoMeta) {
			nextInfoMeta.disabled = false;
			delete nextInfoMeta.disabled_reason;
		}

		return {
			...model,
			meta: nextMeta,
			info: model?.info
				? {
						...model.info,
						...(nextInfoMeta ? { meta: nextInfoMeta } : {})
					}
				: model?.info
		};
	};

	const refreshKonamiModelsInBackground = async () => {
		try {
			models.set(
				await getModels(
					localStorage.token,
					$config?.features?.enable_direct_connections && ($settings?.directConnections ?? null)
				)
			);
		} catch (error) {
			console.warn('[Chat] Failed to refresh models after Konami unlock:', error);
		}
	};

	const refreshModelsAfterLocalProviderSync = async () => {
		try {
			models.set(
				await getModels(
					localStorage.token,
					$config?.features?.enable_direct_connections && ($settings?.directConnections ?? null)
				)
			);
		} catch (error) {
			console.warn('[Chat] Failed to refresh models after local provider sync:', error);
		}
	};

	const refreshModelsForUrlSelection = async (requestedModelIds: string[]): Promise<Model[]> => {
		const currentModels = $models ?? [];
		const requested = normalizeSelectedModelIds(requestedModelIds);
		if (
			requested.length === 0 ||
			requested.every((modelId) => currentModels.some((model) => model?.id === modelId))
		) {
			return currentModels;
		}

		try {
			const refreshedModels = await getModels(
				localStorage.token,
				$config?.features?.enable_direct_connections && ($settings?.directConnections ?? null)
			);
			models.set(refreshedModels);
			return refreshedModels ?? [];
		} catch (error) {
			console.warn('[Chat] Failed to refresh models for URL-selected agent:', error);
			return currentModels;
		}
	};

	const classifyUrlSelectedModelFailure = (modelId: string, availableModels: Model[]) => {
		const model = availableModels.find((candidate) => candidate?.id === modelId);
		if (!model) {
			return 'not_in_models';
		}
		if (getModelAvailability(model, availableModels).disabled) {
			return 'disabled';
		}
		return 'dependency_gate';
	};

	const getUrlSelectedModelErrorMessage = (failureReason: string) =>
		failureReason === 'dependency_gate'
			? 'Agent or model "{{modelId}}" is unavailable. Set up its required integrations and try again.'
			: 'Agent or model "{{modelId}}" is unavailable. Refresh Agents or reinstall the local agent and try again.';

	const openModelSelectorSearch = async (modelId: string) => {
		const modelSelectorButton = document.getElementById('model-selector-0-button');
		if (!modelSelectorButton) {
			return;
		}

		modelSelectorButton.click();
		await tick();

		const modelSelectorInput = document.getElementById('model-search-input') as HTMLInputElement | null;
		if (modelSelectorInput) {
			modelSelectorInput.focus();
			modelSelectorInput.value = modelId;
			modelSelectorInput.dispatchEvent(new Event('input'));
		}
	};

	const handleKonamiUnlockChanged = (event: Event) => {
		const detail = (event as CustomEvent<{ unlocked?: boolean }>).detail;
		if (!detail?.unlocked) {
			return;
		}

		models.update((currentModels) => {
			if (!Array.isArray(currentModels)) {
				return currentModels;
			}

			return currentModels.map((model) =>
				isKonamiUnlockModel(model) ? clearKonamiModelDisabledState(model) : model
			);
		});

		void refreshKonamiModelsInBackground();
	};

	const handleModelsRefreshRequested = () => {
		void refreshModelsAfterLocalProviderSync();
	};

	const openDebugRequestModal = async (requestId: string) => {
		if (!requestId) {
			return;
		}

		try {
			const access = await resolveDebugMonitorAccess();
			const summary = debugMonitorRequestsById[requestId];
			let resolvedChatId = summary?.chat_id || activeDebugMonitorChatId;
			if (!resolvedChatId) {
				const detail = await fetchDebugRequestDetail(requestId, access);
				resolvedChatId =
					typeof detail?.request?.chat_id === 'string' ? detail.request.chat_id : undefined;
			}

			const targetUrl = buildDebugMonitorRequestUrl({
				chatId: resolvedChatId,
				requestId,
				sidebar: 'hidden',
				access
			});
			const hostApi = getWebviewHostApi();
			if (hostApi?.openDebugMonitorLink) {
				const result = await hostApi.openDebugMonitorLink(targetUrl);
				if (result?.success === false) {
					throw new Error(result.error || 'Failed to open debug monitor request');
				}
				return;
			}
			window.open(targetUrl, '_blank', 'noopener,noreferrer');
		} catch (error) {
			console.error('[Chat] Failed to inspect upstream request:', error);
			toast.error($i18n.t('Failed to open upstream request in debug monitor'));
		}
	};

	$: activeDebugMonitorChatId = (activeChatId || chatIdProp || '').trim();

	$: if (browser) {
		void syncDebugMonitorRequests(debugModeEnabled ? activeDebugMonitorChatId : '');
	}

	$: {
		const nextMarkersAfterMessageId: Record<string, DebugMonitorRequestSummary[]> = {};
		const nextMarkersAfterToolBlockByMessageId: Record<
			string,
			Record<number, DebugMonitorRequestSummary[]>
		> = {};
		const nextBackgroundMarkers: DebugMonitorRequestSummary[] = [];
		const messageMap = history?.messages ?? {};
		const visibleMessages = history?.currentId ? createMessagesList(history, history.currentId) : [];
		const visibleMessageIds = new Set(visibleMessages.map((message) => message.id));
		const sortedRequests = Object.values(debugMonitorRequestsById)
			.filter((request) => {
				const requestChatId =
					typeof request?.chat_id === 'string' ? request.chat_id.trim() : '';
				return !activeDebugMonitorChatId || requestChatId === activeDebugMonitorChatId;
			})
			.sort((left, right) => {
				const leftTime = new Date(left.timestamp || '').getTime();
				const rightTime = new Date(right.timestamp || '').getTime();
				if (leftTime !== rightTime) {
					return leftTime - rightTime;
				}
				const leftFollowup = typeof left.followup_index === 'number' ? left.followup_index : -1;
				const rightFollowup = typeof right.followup_index === 'number' ? right.followup_index : -1;
				if (leftFollowup !== rightFollowup) {
					return leftFollowup - rightFollowup;
				}
				return left.request_id.localeCompare(right.request_id);
			});

		for (const request of sortedRequests) {
			const placement = resolveDebugMarkerPlacement(
				request,
				messageMap,
				visibleMessageIds,
			);
			if (placement.kind === 'after_message') {
				if (!nextMarkersAfterMessageId[placement.messageId]) {
					nextMarkersAfterMessageId[placement.messageId] = [];
				}
				nextMarkersAfterMessageId[placement.messageId] = [
					...nextMarkersAfterMessageId[placement.messageId],
					request
				];
				continue;
			}
			if (placement.kind === 'after_tool_block') {
				if (!nextMarkersAfterToolBlockByMessageId[placement.messageId]) {
					nextMarkersAfterToolBlockByMessageId[placement.messageId] = {};
				}
				if (!nextMarkersAfterToolBlockByMessageId[placement.messageId][placement.toolBlockIndex]) {
					nextMarkersAfterToolBlockByMessageId[placement.messageId][placement.toolBlockIndex] = [];
				}
				nextMarkersAfterToolBlockByMessageId[placement.messageId][placement.toolBlockIndex] = [
					...nextMarkersAfterToolBlockByMessageId[placement.messageId][placement.toolBlockIndex],
					request
				];
				continue;
			}
			nextBackgroundMarkers.push(request);
		}

		debugMarkersAfterMessageId = nextMarkersAfterMessageId;
		debugMarkersAfterToolBlockByMessageId = nextMarkersAfterToolBlockByMessageId;
		debugBackgroundMarkers = nextBackgroundMarkers;
	}

	const normalizeWorkflowCostMetrics = (
		summary: Record<string, unknown> | undefined
	): ChatCostMetrics => {
		const cost = parseUsageCostValue(summary?.totalCost);
		const costWithoutCache = parseUsageCostValue(summary?.estimatedCostWithoutCache);
		const cacheSavings = parseUsageCostValue(summary?.netCacheSavings);
		const cachedTokens = Math.max(0, parseUsageInteger(summary?.cachedTokens));
		const cacheReadTokens = Math.max(0, parseUsageInteger(summary?.cacheReadTokens));
		const cacheWriteTokens = Math.max(0, parseUsageInteger(summary?.cacheWriteTokens));
		const reportedSavingsRate = Number(summary?.savingsRate);
		const savingsRate =
			Number.isFinite(reportedSavingsRate)
				? reportedSavingsRate
				: costWithoutCache > 0
					? cacheSavings / costWithoutCache
					: 0;

		return {
			cost,
			costWithoutCache,
			cacheSavings,
			savingsRate,
			cachedTokens,
			cacheReadTokens,
			cacheWriteTokens
		};
	};

	type SubagentDescendantCacheEntry = {
		chatIds: string[];
		truncated: boolean;
		toolCalls: SubagentToolCallDetails;
		fetchedAt: number;
	};
	const subagentDescendantCache = new Map<string, SubagentDescendantCacheEntry>();
	const subagentDescendantRequests = new Map<string, Promise<SubagentDescendantCacheEntry>>();

	const invalidateSubagentDescendantCache = (targetChatId: string) => {
		const normalizedChatId = normalizeChatIdValue(targetChatId);
		if (normalizedChatId) {
			subagentDescendantCache.delete(normalizedChatId);
		}
	};

	const getCachedSubagentDescendants = async (
		targetChatId: string
	): Promise<SubagentDescendantCacheEntry> => {
		const normalizedChatId = normalizeChatIdValue(targetChatId);
		if (!normalizedChatId) {
			return { chatIds: [], truncated: false, toolCalls: {}, fetchedAt: Date.now() };
		}

		const cached = subagentDescendantCache.get(normalizedChatId);
		if (cached && Date.now() - cached.fetchedAt < SUBAGENT_COST_CACHE_TTL_MS) {
			return cached;
		}

		const inFlight = subagentDescendantRequests.get(normalizedChatId);
		if (inFlight) {
			return await inFlight;
		}

		const request: Promise<SubagentDescendantCacheEntry> = getSubagentDescendants(
			localStorage.token,
			normalizedChatId
		)
			.then((payload) => {
				const entry: SubagentDescendantCacheEntry = {
					chatIds: Array.from(
						new Set(
							(payload?.chat_ids ?? [])
								.map((chatId) => normalizeChatIdValue(chatId))
								.filter(Boolean) as string[]
						)
					),
					truncated: payload?.truncated === true,
					toolCalls: normalizeSubagentToolCallDetails(payload?.tool_calls),
					fetchedAt: Date.now()
				};
				subagentDescendantCache.set(normalizedChatId, entry);
				return entry;
			})
			.catch(() => {
				const entry: SubagentDescendantCacheEntry = {
					chatIds: [],
					truncated: false,
					toolCalls: {},
					fetchedAt: Date.now()
				};
				subagentDescendantCache.set(normalizedChatId, entry);
				return entry;
			})
			.finally(() => {
				subagentDescendantRequests.delete(normalizedChatId);
			});
		subagentDescendantRequests.set(normalizedChatId, request);
		return await request;
	};

	const fetchWorkflowCostMetrics = async (chatIds: string[]): Promise<ChatCostMetrics> => {
		const normalizedChatIds = Array.from(
			new Set(chatIds.map((chatId) => normalizeChatIdValue(chatId)).filter(Boolean) as string[])
		);
		if (normalizedChatIds.length === 0) {
			return createEmptyChatCostMetrics();
		}

		const hostApi = getWebviewHostApi();
		if (!hostApi?.getChatCostSummary) {
			return createEmptyChatCostMetrics();
		}

		try {
			const result = await hostApi.getChatCostSummary({ chatIds: normalizedChatIds });
			if (!result?.success) {
				return createEmptyChatCostMetrics();
			}
			return normalizeWorkflowCostMetrics(
				(result.data?.summary ?? {}) as Record<string, unknown>
			);
		} catch (error) {
			console.warn('[Chat] Failed to fetch workflow cost summary:', error);
			return createEmptyChatCostMetrics();
		}
	};

	const fetchContextTurnSummary = async (
		targetChatId: string,
		targetMessageId: string
	): Promise<ChatTurnSummary> => {
		const normalizedChatId = normalizeChatIdValue(targetChatId);
		const normalizedMessageId = String(targetMessageId ?? '').trim();
		if (!normalizedChatId || !normalizedMessageId) {
			return createEmptyChatTurnSummary();
		}

		const hostApi = getWebviewHostApi();
		if (!hostApi?.getChatTurnSummary) {
			return createEmptyChatTurnSummary();
		}

		try {
			const result = await hostApi.getChatTurnSummary({
				chatId: normalizedChatId,
				messageId: normalizedMessageId
			});
			if (!result?.success) {
				return createEmptyChatTurnSummary();
			}
			return normalizeChatTurnSummary(
				(result.data?.summary ?? {}) as Record<string, unknown>
			);
		} catch (error) {
			console.warn('[Chat] Failed to fetch chat turn summary:', error);
			return createEmptyChatTurnSummary();
		}
	};

	let workflowCostMetrics = createEmptyChatCostMetrics();
	let aggregateCostRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let aggregateCostRefreshRequestId = 0;
	let aggregateCostChatId: string | null = null;
	let latestContextMessageId: string | null = null;
	let contextTurnSummary = createEmptyChatTurnSummary();
	let contextTurnSummaryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let contextTurnSummaryRequestId = 0;
	let contextTurnSummaryChatId: string | null = null;
	let contextTurnSummaryKey = '';

	const clearAggregateCostRefreshTimer = () => {
		if (aggregateCostRefreshTimer) {
			clearTimeout(aggregateCostRefreshTimer);
			aggregateCostRefreshTimer = null;
		}
	};

	const clearContextTurnSummaryRefreshTimer = () => {
		if (contextTurnSummaryRefreshTimer) {
			clearTimeout(contextTurnSummaryRefreshTimer);
			contextTurnSummaryRefreshTimer = null;
		}
	};

	const refreshAggregateWorkflowCostMetrics = async (targetChatId: string) => {
		if (!browser || !targetChatId || !localStorage?.token) {
			workflowCostMetrics = createEmptyChatCostMetrics();
			subagentToolCallDetails.set({});
			return;
		}

		const requestId = ++aggregateCostRefreshRequestId;
		const { chatIds: nextDescendantChatIds, toolCalls } =
			await getCachedSubagentDescendants(targetChatId);
		// Instance-local guard (NOT the global chatId store): tile instances
		// never write the global store, so a global guard would key every
		// tile's cost/turn data to the ORCHESTRATOR's chat.
		if (requestId !== aggregateCostRefreshRequestId || targetChatId !== activeChatId) {
			return;
		}
		subagentToolCallDetails.set(toolCalls);
		const nextWorkflowCostMetrics = await fetchWorkflowCostMetrics([
			targetChatId,
			...nextDescendantChatIds
		]);

		if (requestId !== aggregateCostRefreshRequestId || targetChatId !== activeChatId) {
			return;
		}

		workflowCostMetrics = nextWorkflowCostMetrics;
	};

	const refreshContextTurnSummary = async (
		targetChatId: string,
		targetMessageId: string
	) => {
		if (!browser || !targetChatId || !targetMessageId || !localStorage?.token) {
			contextTurnSummary = createEmptyChatTurnSummary();
			return;
		}

		const requestId = ++contextTurnSummaryRequestId;
		const nextContextTurnSummary = await fetchContextTurnSummary(
			targetChatId,
			targetMessageId
		);

		if (
			requestId !== contextTurnSummaryRequestId ||
			targetChatId !== activeChatId ||
			targetMessageId !== latestContextMessageId
		) {
			return;
		}

		contextTurnSummaryChatId = targetChatId;
		contextTurnSummary = nextContextTurnSummary;
	};

	const scheduleAggregateWorkflowCostRefresh = () => {
		if (!browser) return;

		const currentChatId = activeChatId;
		// local: ids are unpersisted temporary chats — the host cost summary reads
		// webui.db, which never has rows for them, so skip the wasted IPC.
		if (!currentChatId || currentChatId.startsWith('local:')) {
			clearAggregateCostRefreshTimer();
			aggregateCostChatId = null;
			workflowCostMetrics = createEmptyChatCostMetrics();
			subagentToolCallDetails.set({});
			return;
		}
		if (!chatFirstPaintReady) {
			clearAggregateCostRefreshTimer();
			return;
		}

		if (aggregateCostChatId !== currentChatId) {
			aggregateCostChatId = currentChatId;
			workflowCostMetrics = createEmptyChatCostMetrics();
		}

		clearAggregateCostRefreshTimer();
		aggregateCostRefreshTimer = setTimeout(() => {
			void refreshAggregateWorkflowCostMetrics(currentChatId);
		}, SUBAGENT_COST_REFRESH_DEBOUNCE_MS);
	};

	const scheduleContextTurnSummaryRefresh = () => {
		if (!browser) return;

		const currentChatId = activeChatId;
		const currentMessageId = latestContextMessageId;
		// local: temporary chats have no server-side turn summary; the composer
		// falls back to local history usage either way.
		if (!currentChatId || currentChatId.startsWith('local:') || !currentMessageId) {
			clearContextTurnSummaryRefreshTimer();
			contextTurnSummaryChatId = null;
			contextTurnSummaryKey = '';
			contextTurnSummary = createEmptyChatTurnSummary();
			return;
		}
		if (!chatFirstPaintReady) {
			clearContextTurnSummaryRefreshTimer();
			return;
		}

		if (contextTurnSummaryChatId !== currentChatId) {
			contextTurnSummaryChatId = currentChatId;
			contextTurnSummary = createEmptyChatTurnSummary();
		}

		const nextKey = `${currentChatId}:${currentMessageId}`;
		if (contextTurnSummaryKey !== nextKey) {
			contextTurnSummaryKey = nextKey;
		}

		clearContextTurnSummaryRefreshTimer();
		contextTurnSummaryRefreshTimer = setTimeout(() => {
			void refreshContextTurnSummary(currentChatId, currentMessageId);
		}, SUBAGENT_COST_REFRESH_DEBOUNCE_MS);
	};

	const isStaleStreamingContentRegression = (message: any, incomingContent: unknown): boolean => {
		if (message?.role !== 'assistant' || isAssistantMessageTerminal(message)) {
			return false;
		}

		if (typeof incomingContent !== 'string') {
			return false;
		}

		const currentContent = typeof message?.content === 'string' ? message.content : '';
		if (!currentContent) {
			return false;
		}

		return (
			incomingContent.length < currentContent.length && currentContent.startsWith(incomingContent)
		);
	};

	const FRAMEWORK_EMPTY_COMMENT = '<!---->';
	const FRAMEWORK_EMPTY_COMMENT_PATTERN = /<!---->/g;
	const FRAMEWORK_BLANK_COMMENT_PATTERN = /<!--\s*-->/g;
	const FRAMEWORK_HTML_HINT_PATTERN = /<(?:p|div|span|ul|ol|li|h[1-6])\b/i;

	const stripFrameworkCommentArtifacts = (content: string): string => {
		if (!content || !content.includes(FRAMEWORK_EMPTY_COMMENT)) {
			return content;
		}

		const commentCount = (content.match(FRAMEWORK_EMPTY_COMMENT_PATTERN) ?? []).length;
		if (commentCount < 3 && !FRAMEWORK_HTML_HINT_PATTERN.test(content)) {
			return content;
		}

		return content
			.replace(FRAMEWORK_EMPTY_COMMENT_PATTERN, '')
			.replace(FRAMEWORK_BLANK_COMMENT_PATTERN, '');
	};

		const STREAMING_REPLACEMENT_SOURCES = new Set(['chat:completion.content', 'chat:message', 'replace']);
		const STRUCTURED_STREAMING_MARKERS = [
			/<details\s+type="reasoning"/i,
			/<details\s+type="tool_calls"/i,
			/<think>/i,
			/<\/think>/i,
			...EXTRA_REASONING_STREAMING_MARKERS
		];
		const STOPPABLE_DETAILS_TYPES = new Set([
			'reasoning',
			'tool_calls',
			'tool_preparation',
			'tool_analysis',
			'code_interpreter'
		]);
		const FORCE_STOP_BLOCKED_EVENT_TYPES = new Set([
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
			'chat:message:follow_ups',
			'source',
			'citation'
		]);
		const USER_STOP_REASON = 'user_stop';
		const TERMINAL_ERROR_STOP_REASON = 'upstream_error';
		const STREAM_PROGRESS_STATUS_ACTION = 'stream_progress_heartbeat';
		const UNVERIFIED_TOOL_CLAIM_NOTE =
			'\n\n> System note: This response includes tool/file execution claims, but no verified MCP tool call was recorded.';
		const TOOL_EXECUTION_CLAIM_PATTERNS = [
			/\b(?:tool|function|command|script|mcp)\b[\s\S]{0,80}\b(?:ran|run|executed|called|invoked|succeeded|successful|completed)\b/i,
			/\b(?:ran|run|executed|called|invoked|used)\b[\s\S]{0,40}\b(?:tool|function|command|script|mcp)\b/i
		];
		const TOOL_OUTPUT_CLAIM_PATTERN =
			/\b(?:created|saved|wrote|exported|generated|uploaded)\b[\s\S]{0,80}\b(?:file|spreadsheet|worksheet|excel|csv|xlsx|artifact)\b/i;
		const FILE_TARGET_PATTERN =
			/(?:~?\/[^\s"'`<>]+|\b[A-Za-z]:\\[^\s"'`<>]+|\b[^\s"'`<>]+\.(?:xlsx|csv|json|txt|md|html|pdf)\b)/i;
		const TOOL_CALL_BOILERPLATE_PATTERN =
			/(?:\"tool_calls\"\s*:|\"function\"\s*:\s*\{|\"arguments\"\s*:\s*\{)/i;
		const forceStoppedMessageIds = new Set<string>();
		const STREAM_PERF_LOG_INTERVAL_MS = 10000;
		const STREAM_PERF_INACTIVE_TIMEOUT_MS = 20000;

		const parseNonNegativeInt = (value: unknown): number | null => {
			if (value === null || value === undefined) return null;
			const parsed =
				typeof value === 'number'
					? Math.floor(value)
					: Number.parseInt(String(value).trim(), 10);
			if (!Number.isFinite(parsed) || parsed < 0) return null;
			return parsed;
		};

		const getDetailAttributeValue = (tag: string, name: string): string | null => {
			const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const doubleQuoteMatch = new RegExp(`\\b${escapedName}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
			if (doubleQuoteMatch) return doubleQuoteMatch[1];
			const singleQuoteMatch = new RegExp(`\\b${escapedName}\\s*=\\s*'([^']*)'`, 'i').exec(tag);
			return singleQuoteMatch ? singleQuoteMatch[1] : null;
		};

		const setDetailAttributeValue = (tag: string, name: string, value: string): string => {
			const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const sanitizedValue = value.replace(/"/g, '&quot;');
			const doubleQuotePattern = new RegExp(`(\\b${escapedName}\\s*=\\s*)"[^"]*"`, 'i');
			if (doubleQuotePattern.test(tag)) {
				return tag.replace(doubleQuotePattern, `$1"${sanitizedValue}"`);
			}
			const singleQuotePattern = new RegExp(`(\\b${escapedName}\\s*=\\s*)'[^']*'`, 'i');
			if (singleQuotePattern.test(tag)) {
				return tag.replace(singleQuotePattern, `$1"${sanitizedValue}"`);
			}
			return tag.replace(/>$/, ` ${name}="${sanitizedValue}">`);
		};

		const normalizeStopReason = (
			existingStopReason: unknown,
			requestedStopReason: string | null
		): string | null => {
			const normalizedExisting = String(existingStopReason ?? '').trim();
			const normalizedRequested = String(requestedStopReason ?? '').trim();
			if (normalizedExisting === USER_STOP_REASON) return USER_STOP_REASON;
			if (normalizedRequested === USER_STOP_REASON) return USER_STOP_REASON;
			return normalizedExisting || normalizedRequested || null;
		};

		const extractAssistantErrorContent = (
			message: Record<string, unknown> | null | undefined
		): string => {
			if (!message || message.role !== 'assistant') {
				return '';
			}

			const error = (message as Record<string, any>).error;
			if (error === true) {
				return typeof message.content === 'string' ? message.content : '';
			}
			if (!error || error === false) {
				return '';
			}
			if (typeof error === 'string') {
				return error;
			}
			if (typeof error?.content === 'string') {
				return error.content;
			}
			if (typeof error?.error?.content === 'string') {
				return error.error.content;
			}
			if (typeof error?.detail === 'string') {
				return error.detail;
			}
			if (typeof error?.error?.message === 'string') {
				return error.error.message;
			}
			if (typeof error?.error === 'string') {
				return error.error;
			}
			if (typeof error?.message === 'string') {
				return error.message;
			}
			return '';
		};

		const hasAssistantTerminalError = (
			message: Record<string, unknown> | null | undefined
		): boolean => {
			if (!message || message.role !== 'assistant') {
				return false;
			}

			const error = (message as Record<string, any>).error;
			if (error === true) {
				return true;
			}
			if (!error || error === false) {
				return false;
			}

			if (typeof error === 'object') {
				return true;
			}

			return extractAssistantErrorContent(message).trim().length > 0;
		};

		const resolveAssistantStopReason = (
			message: Record<string, unknown> | null | undefined,
			fallbackStopReason: string | null
		): string | null => {
			const normalized = normalizeStopReason(message?.stop_reason, fallbackStopReason);
			if (normalized) {
				return normalized;
			}
			return hasAssistantTerminalError(message) ? TERMINAL_ERROR_STOP_REASON : null;
		};

		const hasAssistantStopReason = (
			message: Record<string, unknown> | null | undefined
		): boolean => !!String(message?.stop_reason ?? '').trim();

		const isAssistantMessageTerminal = (
			message: Record<string, unknown> | null | undefined
		): boolean => {
			if (!message || message.role !== 'assistant') {
				return false;
			}
			return (
				message.done === true ||
				hasAssistantTerminalError(message) ||
				hasAssistantStopReason(message)
			);
		};

		const isAssistantMessageActive = (
			message: Record<string, unknown> | null | undefined
		): boolean => {
			return !!message && message.role === 'assistant' && !isAssistantMessageTerminal(message);
		};

		const getAssistantMessageTimestampMs = (
			message: Record<string, unknown> | null | undefined
		): number | null => {
			const rawTimestamp =
				typeof message?.timestamp === 'number'
					? message.timestamp
					: Number(message?.timestamp ?? 0);
			if (!Number.isFinite(rawTimestamp) || rawTimestamp <= 0) {
				return null;
			}
			return rawTimestamp > 1_000_000_000_000 ? rawTimestamp : rawTimestamp * 1000;
		};

		const getAssistantVisibleTokenCount = (
			message: Record<string, unknown> | null | undefined
		): number => {
			const tokenCount = getDisplayTokenCountFromUsage(
				((message as Record<string, any> | null | undefined)?.usage ?? {}) as Record<string, unknown>
			);
			return Number.isFinite(tokenCount) && tokenCount > 0 ? tokenCount : 0;
		};

		const assistantMessageHasVisibleProgress = (
			message: Record<string, unknown> | null | undefined
		): boolean => {
			const content =
				typeof message?.content === 'string'
					? stripFrameworkCommentArtifacts(message.content).trim()
					: '';
			return content.length > 0 || getAssistantVisibleTokenCount(message) > 0;
		};

		const buildStreamingProgressStatus = (
			message: Record<string, unknown> | null | undefined,
			observedAt = Date.now()
		) => {
			const startedAtMs = getAssistantMessageTimestampMs(message) ?? observedAt;
			const elapsedSeconds = Math.max(0, Math.floor((observedAt - startedAtMs) / 1000));
			const tokenCount = getAssistantVisibleTokenCount(message);
			const tokenSuffix =
				tokenCount > 0 ? `, ${tokenCount.toLocaleString()} tokens observed` : '';
			return {
				action: STREAM_PROGRESS_STATUS_ACTION,
				description: `Still working... ${elapsedSeconds}s elapsed${tokenSuffix}`,
				done: false,
				hidden: false,
				observed_at: observedAt
			};
		};

		const clearStreamingProgressStatus = (
			message: Record<string, unknown> | null | undefined
		): boolean => {
			if (!message || !Array.isArray(message.statusHistory)) {
				return false;
			}
			const nextHistory = message.statusHistory.filter(
				(status) => status?.action !== STREAM_PROGRESS_STATUS_ACTION
			);
			if (nextHistory.length === message.statusHistory.length) {
				return false;
			}
			message.statusHistory = nextHistory;
			return true;
		};

		const upsertStreamingProgressStatus = (
			message: Record<string, unknown> | null | undefined,
			observedAt = Date.now()
		): boolean => {
			if (!message || message.role !== 'assistant') {
				return false;
			}
			const nextStatus = buildStreamingProgressStatus(message, observedAt);
			const nextHistory = Array.isArray(message.statusHistory) ? [...message.statusHistory] : [];
			const existingIndex = nextHistory.findIndex(
				(status) => status?.action === STREAM_PROGRESS_STATUS_ACTION
			);

			if (existingIndex >= 0) {
				const existingStatus = nextHistory[existingIndex] ?? {};
				if (
					existingStatus.description === nextStatus.description &&
					existingStatus.done === nextStatus.done
				) {
					return false;
				}
				nextHistory[existingIndex] = {
					...existingStatus,
					...nextStatus
				};
			} else {
				nextHistory.push(nextStatus);
			}

			message.statusHistory = nextHistory;
			return true;
		};

		const noteVisibleAssistantProgress = (
			message: Record<string, unknown> | null | undefined
		): boolean => {
			const messageId = typeof message?.id === 'string' ? message.id : null;
			if (!messageId) {
				return false;
			}

			lastVisibleProgressTimeByMessageId[messageId] = Date.now();
			delete lastInvisibleProgressPollTimeByMessageId[messageId];
			composerStreamingStateVersion += 1;
			return clearStreamingProgressStatus(message);
		};

		const getFallbackDurationSeconds = (source: Record<string, unknown>): number | null => {
			const duration = parseNonNegativeInt(source.duration);
			if (duration !== null) return duration;

			const elapsed = parseNonNegativeInt(source.elapsed);
			if (elapsed !== null) return elapsed;

			const startedAtRaw = source.started_at;
			const startedAt =
				typeof startedAtRaw === 'number'
					? startedAtRaw
					: Number.parseFloat(String(startedAtRaw ?? '').trim());
			if (Number.isFinite(startedAt) && startedAt > 0) {
				return Math.max(0, Math.floor(Date.now() / 1000 - startedAt));
			}

			return null;
		};

		const freezeRunningDetailsMarkup = (
			content: string,
			stopReason: string | null
		): { content: string; changed: boolean } => {
			if (!content || !content.includes('<details')) {
				return { content, changed: false };
			}

			let changed = false;
			const nextContent = content.replace(/<details\b[^>]*>/gi, (detailsTag) => {
				const detailsType = String(getDetailAttributeValue(detailsTag, 'type') ?? '')
					.trim()
					.toLowerCase();
				if (!STOPPABLE_DETAILS_TYPES.has(detailsType)) {
					return detailsTag;
				}

				const doneAttr = String(getDetailAttributeValue(detailsTag, 'done') ?? '')
					.trim()
					.toLowerCase();
				const isDone = doneAttr === 'true';
				const reasonToApply = normalizeStopReason(
					getDetailAttributeValue(detailsTag, 'stop_reason'),
					stopReason
				);

				let nextTag = detailsTag;
				if (!isDone) {
					nextTag = setDetailAttributeValue(nextTag, 'done', 'true');
					const durationSeconds = getFallbackDurationSeconds({
						duration: getDetailAttributeValue(nextTag, 'duration'),
						elapsed: getDetailAttributeValue(nextTag, 'elapsed'),
						started_at: getDetailAttributeValue(nextTag, 'started_at')
					});
					if (durationSeconds !== null) {
						nextTag = setDetailAttributeValue(nextTag, 'duration', String(durationSeconds));
					}
				}

				if (reasonToApply) {
					nextTag = setDetailAttributeValue(nextTag, 'stop_reason', reasonToApply);
				}

				if (nextTag !== detailsTag) {
					changed = true;
				}
				return nextTag;
			});

			return { content: nextContent, changed };
		};

		const freezeRunningContentBlocks = (
			contentBlocks: unknown,
			stopReason: string | null
		): { contentBlocks: unknown; changed: boolean } => {
			if (!Array.isArray(contentBlocks)) {
				return { contentBlocks, changed: false };
			}

			let changed = false;
			const nextBlocks = contentBlocks.map((rawBlock) => {
				if (!rawBlock || typeof rawBlock !== 'object') return rawBlock;
				const block = rawBlock as Record<string, unknown>;
				const blockType = String(block.type ?? '')
					.trim()
					.toLowerCase();
				if (!STOPPABLE_DETAILS_TYPES.has(blockType)) return rawBlock;

				const isDone = block.done === true || String(block.done ?? '').toLowerCase() === 'true';
				const normalizedReason = normalizeStopReason(block.stop_reason, stopReason);
				const nextBlock: Record<string, unknown> = { ...block };
				let localChanged = false;

				if (!isDone) {
					nextBlock.done = true;
					const durationSeconds = getFallbackDurationSeconds(nextBlock);
					if (durationSeconds !== null) {
						nextBlock.duration = durationSeconds;
					}
					localChanged = true;
				}

				if (normalizedReason && nextBlock.stop_reason !== normalizedReason) {
					nextBlock.stop_reason = normalizedReason;
					localChanged = true;
				}

				if (!localChanged) {
					return rawBlock;
				}

				changed = true;
				return nextBlock;
			});

			return { contentBlocks: nextBlocks, changed };
		};

		const hasRunningStoppableDetailsMarkup = (content: unknown): boolean => {
			if (typeof content !== 'string' || !content.includes('<details')) {
				return false;
			}

			const detailsTags = content.match(/<details\b[^>]*>/gi) ?? [];
			for (const detailsTag of detailsTags) {
				const detailsType = String(getDetailAttributeValue(detailsTag, 'type') ?? '')
					.trim()
					.toLowerCase();
				if (!STOPPABLE_DETAILS_TYPES.has(detailsType)) {
					continue;
				}

				const doneAttr = String(getDetailAttributeValue(detailsTag, 'done') ?? '')
					.trim()
					.toLowerCase();
				const stopReasonAttr = String(
					getDetailAttributeValue(detailsTag, 'stop_reason') ?? ''
				).trim();
				const endedAtAttr = String(getDetailAttributeValue(detailsTag, 'ended_at') ?? '').trim();

				if (doneAttr !== 'true' && !stopReasonAttr && !endedAtAttr) {
					return true;
				}
			}

			return false;
		};

		const hasRunningStoppableContentBlocks = (contentBlocks: unknown): boolean => {
			if (!Array.isArray(contentBlocks)) {
				return false;
			}

			return contentBlocks.some((rawBlock) => {
				if (!rawBlock || typeof rawBlock !== 'object') return false;
				const block = rawBlock as Record<string, unknown>;
				const blockType = String(block.type ?? '')
					.trim()
					.toLowerCase();
				if (!STOPPABLE_DETAILS_TYPES.has(blockType)) {
					return false;
				}

				const blockDone =
					block.done === true || String(block.done ?? '').trim().toLowerCase() === 'true';
				const blockStopReason = String(block.stop_reason ?? '').trim();
				const blockEndedAt = block.ended_at;
				const hasEndedAt =
					blockEndedAt !== null &&
					blockEndedAt !== undefined &&
					String(blockEndedAt).trim() !== '';

				return !blockDone && !blockStopReason && !hasEndedAt;
			});
		};

		const assistantMessageHasRunningStoppableDetails = (
			message: Record<string, unknown> | null | undefined
		): boolean => {
			if (!message || message.role !== 'assistant') {
				return false;
			}

			return (
				hasRunningStoppableDetailsMarkup(message.content) ||
				hasRunningStoppableContentBlocks(message.contentBlocks)
			);
		};

		const browserFacingWorkspaceUrl = (url: string): string =>
			url.replace(
				/^http:\/\/host\.docker\.internal:9876\/workspace\//,
				'http://localhost:9876/workspace/'
			);

		const normalizeInlineFileIdentity = (file: any): string => {
			if (typeof file === 'string') {
				return file.startsWith('data:image/') ? `data:${file}` : `string:${file}`;
			}
			if (!file || typeof file !== 'object') return '';

			const url = typeof file.url === 'string' ? file.url.trim() : '';
			if (url) {
				try {
					const parsed = new URL(url, 'http://localhost');
					return `url:${parsed.pathname}${parsed.search}`;
				} catch (_error) {
					return `url:${url}`;
				}
			}

			const content = typeof file.content === 'string' ? file.content : '';
			if (content.startsWith('data:image/')) return `data:${content}`;

			try {
				return `json:${JSON.stringify(file)}`;
			} catch (_error) {
				return '';
			}
		};

		const mergeDistinctInlineFiles = (existingFiles: any[] = [], nextFiles: any[] = []): any[] => {
			const merged: any[] = [];
			const seen = new Set<string>();

			for (const file of [
				...(Array.isArray(existingFiles) ? existingFiles : []),
				...(Array.isArray(nextFiles) ? nextFiles : [])
			]) {
				const identity = normalizeInlineFileIdentity(file);
				if (!identity || seen.has(identity)) continue;
				seen.add(identity);
				merged.push(file);
			}

			return merged;
		};

		const formatHydratedContentArrayForDisplay = (content: unknown[]): string => {
			const textParts: string[] = [];
			const imageUrls: string[] = [];
			let imageCount = 0;

			for (const rawBlock of content) {
				if (!rawBlock || typeof rawBlock !== 'object') continue;
				const block = rawBlock as Record<string, any>;
				const blockType = String(block.type ?? '')
					.trim()
					.toLowerCase();

				if (blockType === 'text' || blockType === 'input_text') {
					const text = String(block.text ?? '').trim();
					if (text) textParts.push(text);
				} else if (blockType === 'image_url') {
					imageCount += 1;
					const url = String(block.image_url?.url ?? '').trim();
					if (url && !url.startsWith('data:image/')) imageUrls.push(browserFacingWorkspaceUrl(url));
				} else if (blockType === 'image') {
					imageCount += 1;
				}
			}

			let display = textParts.join('\n\n');
			if (imageCount > 0) {
				if (display) display += '\n\n';
				display += 'Image inputs attached for model analysis:';
				imageUrls.forEach((url, index) => {
					display += `\n${index + 1}. ${url}`;
				});
				if (imageUrls.length < imageCount) {
					display += `\n${imageCount - imageUrls.length} image input(s) were attached without displayable URLs.`;
				}
			}

			return display;
		};

		const normalizeHydratedMessageContent = (
			message: Record<string, any> | null | undefined
		): boolean => {
			if (!message || !Array.isArray(message.content)) {
				return false;
			}

			message.content = formatHydratedContentArrayForDisplay(message.content);
			return true;
		};

		const normalizeHydratedAssistantMessages = (
			messagesMap: Record<string, any> | null | undefined,
			{ hasActiveChatTasks }: { hasActiveChatTasks: boolean }
		) => {
			let changed = false;
			let staleNormalizedCount = 0;

			if (!messagesMap) {
				return { changed, staleNormalizedCount };
			}

			for (const [messageId, message] of Object.entries(messagesMap)) {
				if (normalizeHydratedMessageContent(message)) {
					changed = true;
				}

				if (message?.role !== 'assistant') {
					continue;
				}

				if (typeof message.content === 'string') {
					const strippedContent = stripFrameworkCommentArtifacts(message.content);
					if (strippedContent !== message.content) {
						message.content = strippedContent;
						changed = true;
					}
				}

				const terminalStopReason = resolveAssistantStopReason(message, null);
				if (hasAssistantTerminalError(message)) {
					if (
						applyLocalStopToAssistantMessage(
							message,
							terminalStopReason ?? TERMINAL_ERROR_STOP_REASON
						)
					) {
						changed = true;
					}
					clearStreamingProgressState(message.id ?? messageId);
					continue;
				}

				if (
					isAssistantMessageTerminal(message) &&
					assistantMessageHasRunningStoppableDetails(message)
				) {
					if (applyLocalStopToAssistantMessage(message, terminalStopReason)) {
						changed = true;
					}
					clearStreamingProgressState(message.id ?? messageId);
					continue;
				}

				if (message.done === undefined || message.done === null) {
					// Trust explicit done=false placeholders from active turns.
					// Missing done markers are treated as legacy/synced terminal history.
					message.done = true;
					changed = true;
				}
			}

			if (hasActiveChatTasks) {
				return { changed, staleNormalizedCount };
			}

			for (const [messageId, message] of Object.entries(messagesMap)) {
				if (
					message?.role !== 'assistant' ||
					!assistantMessageHasRunningStoppableDetails(message)
				) {
					continue;
				}

				const terminalStopReason = resolveAssistantStopReason(message, null);
				const messageIsTerminal = isAssistantMessageTerminal(message);
				const messageTimestamp =
					typeof message.timestamp === 'number'
						? message.timestamp
						: Number(message.timestamp ?? 0);
				const messageAgeSeconds =
					messageTimestamp > 0 ? Date.now() / 1000 - messageTimestamp : Number.POSITIVE_INFINITY;

				if (!messageIsTerminal && messageAgeSeconds < 15) {
					continue;
				}

				if (
					applyLocalStopToAssistantMessage(
						message,
						messageIsTerminal ? terminalStopReason : 'client_disconnect'
					)
				) {
					changed = true;
				}
				clearStreamingProgressState(messageId);
				clearStreamingMessageCommitState(messageId);
				staleNormalizedCount += 1;
			}

			return { changed, staleNormalizedCount };
		};

		const normalizeHydratedMessagesForFirstPaint = (
			messagesMap: Record<string, any> | null | undefined
		): { changed: boolean } => {
			let changed = false;
			if (!messagesMap) {
				return { changed };
			}

			for (const message of Object.values(messagesMap)) {
				if (normalizeHydratedMessageContent(message)) {
					changed = true;
				}

				if (
					message?.role === 'assistant' &&
					(message.done === undefined || message.done === null)
				) {
					// Missing markers are legacy terminal history. Leave explicit false
					// placeholders untouched until deferred task state can reconcile them.
					message.done = true;
					changed = true;
				}
			}

			return { changed };
		};

		const applyLocalStopToAssistantMessage = (
			message: Record<string, unknown> | null | undefined,
			stopReason: string | null
		): boolean => {
			if (!message || message.role !== 'assistant') {
				return false;
			}

			let changed = false;
			if (message.done !== true) {
				message.done = true;
				changed = true;
			}

			const normalizedReason = normalizeStopReason(message.stop_reason, stopReason);
			if (normalizedReason && message.stop_reason !== normalizedReason) {
				message.stop_reason = normalizedReason;
				changed = true;
			}

			if (clearStreamingProgressStatus(message)) {
				changed = true;
			}

			if (typeof message.content === 'string') {
				const frozenMarkup = freezeRunningDetailsMarkup(message.content, normalizedReason);
				if (frozenMarkup.changed) {
					message.content = frozenMarkup.content;
					changed = true;
				}
			}

			const frozenContentBlocks = freezeRunningContentBlocks(message.contentBlocks, normalizedReason);
			if (frozenContentBlocks.changed) {
				message.contentBlocks = frozenContentBlocks.contentBlocks;
				changed = true;
			}

			return changed;
		};

		const getActiveAssistantMessageIds = (): string[] => {
			if (!history?.messages) return [];
			return Object.entries(history.messages)
				.filter(([_, msg]: [string, any]) => isAssistantMessageActive(msg))
				.map(([messageId]) => messageId);
		};

		const applyImmediateStopState = (stopReason: string | null) => {
			const activeMessageIds = getActiveAssistantMessageIds();
			for (const messageId of activeMessageIds) {
				const message = history.messages[messageId];
				if (!message || message.role !== 'assistant') continue;
				if (applyLocalStopToAssistantMessage(message, stopReason)) {
					history.messages[messageId] = message;
				}
				if (stopReason === USER_STOP_REASON) {
					forceStoppedMessageIds.add(messageId);
					composerStreamingStateVersion += 1;
				}
				clearStreamingProgressState(messageId);
				delete streamUsageStateByMessageId[messageId];
				clearStreamingMessageCommitState(messageId);
			}

			clearRateLimitOverlay();
			stopStreamWatchdog();
			setTaskIds(null);
			generating = false;
			generationController?.abort();
			generationController = null;

			// PORTICO PATCH (N-012): drop any pending tool-confirmation chips and
			// any staged click intent when the assistant turn that produced them
			// is force-stopped (user pressed Stop, client disconnect, terminal
			// stream error, etc.). The chips are tied to a specific assistant
			// turn — if that turn is abandoned, the chips are orphaned. Leaving
			// them visible would let the user "approve" an action whose context
			// no longer exists in the conversation, which is both a UX bug
			// (stale chip) and a subtle gate-bypass risk (the gate's per-chat
			// ``_pending`` would still resolve a click on the orphaned hash on
			// the NEXT user turn, dispatching a tool the user no longer
			// intends). The backend's ``consume_user_turn`` will drop the
			// gate's pending entries on the next user message; mirroring it on
			// the frontend keeps the two sides in sync.
			pendingToolConfirmations = [];
			toolConfirmationBatchInFlight = false;

			history = history;
		};

		const stopTasksBestEffort = async (candidateTaskIds: string[]) => {
			if (candidateTaskIds.length === 0) return;

			const results = await Promise.allSettled(
				candidateTaskIds.map((taskId) =>
					stopTask(localStorage.token, taskId).catch((error) => {
						throw { taskId, error };
					})
				)
			);

			const failures = results.filter((result) => result.status === 'rejected');
			if (failures.length > 0) {
				console.warn('[Stop] Failed to stop some tasks', {
					failureCount: failures.length,
					total: candidateTaskIds.length
				});
			}
		};

	const hasStructuredStreamingMarkup = (content: string): boolean => {
		for (const pattern of STRUCTURED_STREAMING_MARKERS) {
			if (pattern.test(content)) {
				return true;
			}
		}
		return false;
	};

	const recordStreamingContentSnapshot = (
		messageId: string | undefined | null,
		content: unknown
	) => {
		if (!messageId || typeof content !== 'string') return;
		// Durable length only: transient open thinking-indicator blocks are
		// pruned server-side when no summary text ever arrives, so counting
		// them made the pruned first-token snapshot look like a stale shrink.
		const nextLength = stripOpenReasoningBlocks(content).length;
		if (nextLength <= 0) return;
		const previousLength = streamMaxContentLengthByMessageId[messageId] ?? 0;
		if (nextLength > previousLength) {
			streamMaxContentLengthByMessageId[messageId] = nextLength;
		}
	};

	const isStreamingSnapshotRegression = (
		message: any,
		incomingContent: string,
		source: string
	): boolean => {
		if (!STREAMING_REPLACEMENT_SOURCES.has(source)) {
			return false;
		}

		if (message?.role !== 'assistant' || isAssistantMessageTerminal(message)) {
			return false;
		}

		// Structured snapshots (reasoning/tool details) may legitimately revise
		// the middle of the message; let dedicated guards handle those.
		if (hasStructuredStreamingMarkup(incomingContent)) {
			return false;
		}

		const messageId = typeof message?.id === 'string' ? message.id : null;
		if (!messageId) return false;

		const maxSeenLength = streamMaxContentLengthByMessageId[messageId] ?? 0;
		return (
			maxSeenLength > 0 && stripOpenReasoningBlocks(incomingContent).length < maxSeenLength
		);
	};

	const getStreamContentOrderState = (messageId: string) => {
		return (
			streamContentOrderStateByMessageId[messageId] ??
			(streamContentOrderStateByMessageId[messageId] = {
				sawDeltaChunk: false,
				nonMonotonicSkips: 0
			})
		);
	};

	const markStreamingDeltaChunk = (messageId: string | undefined | null) => {
		if (!messageId) return;
		getStreamContentOrderState(messageId).sawDeltaChunk = true;
	};

	const isNonMonotonicStreamingReplacement = (
		message: any,
		incomingContent: string,
		source: string
	): boolean => {
		if (!STREAMING_REPLACEMENT_SOURCES.has(source)) {
			return false;
		}

		if (message?.role !== 'assistant' || isAssistantMessageTerminal(message)) {
			return false;
		}

		const messageId = typeof message?.id === 'string' ? message.id : null;
		if (!messageId) {
			return false;
		}

		const currentContent = typeof message?.content === 'string' ? message.content : '';
		// Compare against DURABLE current content: a transient open
		// thinking-indicator block (pruned server-side once text arrives, or
		// left stale by a dropped flush) must not make the follow-up plain
		// snapshot look non-monotonic.
		const currentDurable = stripOpenReasoningBlocks(currentContent);
		if (!currentDurable || !incomingContent) {
			return false;
		}

		if (hasStructuredStreamingMarkup(incomingContent)) {
			return false;
		}

		// Prefix extension is a normal progressive stream update.
		if (incomingContent.startsWith(currentDurable)) {
			return false;
		}

		// Do not stall progress: if replacement content grows, accept it even when not a strict prefix.
		// Some providers revise earlier spans while continuing to append new text.
		if (incomingContent.length > currentDurable.length) {
			return false;
		}

		// True regressions are handled by isStaleStreamingContentRegression.
		if (currentDurable.startsWith(incomingContent)) {
			return false;
		}

		const orderState = getStreamContentOrderState(messageId);

		// Some providers emit replacement-only streams; only suppress after observing delta chunks.
		if (!orderState.sawDeltaChunk) {
			return false;
		}

		orderState.nonMonotonicSkips += 1;

		if (DEBUG_CHAT_EVENTS) {
			console.warn('[Chat] Ignoring non-monotonic streaming replacement', {
				source,
				messageId,
				currentLength: currentDurable.length,
				incomingLength: incomingContent.length,
				skippedCount: orderState.nonMonotonicSkips
			});
		}

		return true;
	};

	const applyMessageContentUpdate = (
		message: any,
		incomingContent: unknown,
		source: string
	): boolean => {
		if (typeof incomingContent !== 'string') {
			return false;
		}

		const normalizedIncomingContent = stripFrameworkCommentArtifacts(incomingContent);

		if (
			typeof message?.content === 'string' &&
			message.content === normalizedIncomingContent
		) {
			return false;
		}

		if (isStaleStreamingContentRegression(message, normalizedIncomingContent)) {
			if (DEBUG_CHAT_EVENTS) {
				console.debug('[Chat] Ignoring stale content regression', {
					source,
					messageId: message?.id,
					currentLength: typeof message?.content === 'string' ? message.content.length : 0,
					incomingLength: normalizedIncomingContent.length
				});
			}
			return false;
		}

		if (isStreamingSnapshotRegression(message, normalizedIncomingContent, source)) {
			if (DEBUG_CHAT_EVENTS) {
				console.debug('[Chat] Ignoring streaming snapshot regression', {
					source,
					messageId: message?.id,
					incomingLength: normalizedIncomingContent.length,
					maxSeenLength:
						typeof message?.id === 'string'
							? (streamMaxContentLengthByMessageId[message.id] ?? 0)
							: 0
				});
			}
			return false;
		}

		if (isNonMonotonicStreamingReplacement(message, normalizedIncomingContent, source)) {
			return false;
		}

		message.content = normalizedIncomingContent;
		recordStreamingContentSnapshot(message?.id, normalizedIncomingContent);
		noteVisibleAssistantProgress(message);
		return true;
	};

	const extractToolCallsFromContentBlocks = (contentBlocks: unknown): unknown[] => {
		if (!Array.isArray(contentBlocks)) return [];

		const extracted: unknown[] = [];
		for (const block of contentBlocks) {
			if (!block || typeof block !== 'object') continue;
			if (String((block as Record<string, unknown>).type ?? '') !== 'tool_calls') continue;

			const blockContent = (block as Record<string, unknown>).content;
			if (Array.isArray(blockContent)) {
				for (const toolCall of blockContent) {
					if (toolCall) extracted.push(toolCall);
				}
			} else if (blockContent) {
				extracted.push(blockContent);
			}
		}

		return extracted;
	};

	const stripUnverifiedToolClaimNote = (content: string): string => {
		if (!content || !content.includes(UNVERIFIED_TOOL_CLAIM_NOTE)) return content;
		return content.replace(UNVERIFIED_TOOL_CLAIM_NOTE, '');
	};

	const looksLikeUnverifiedToolExecutionClaim = (content: string): boolean => {
		if (!content) return false;
		const normalized = content.replace(/<details[\s\S]*?<\/details>/gi, ' ');
		if (!normalized.trim()) return false;

		const hasExecutionClaim = TOOL_EXECUTION_CLAIM_PATTERNS.some((pattern) => pattern.test(normalized));
		const hasOutputClaim =
			TOOL_OUTPUT_CLAIM_PATTERN.test(normalized) && FILE_TARGET_PATTERN.test(normalized);
		const hasBoilerplateClaim = TOOL_CALL_BOILERPLATE_PATTERN.test(normalized);

		return hasExecutionClaim || hasOutputClaim || hasBoilerplateClaim;
	};

	const applyToolExecutionClaimGuardrail = (
		message: any,
		payloadToolCalls: unknown,
		payloadContentBlocks: unknown
	): boolean => {
		if (!message || message.role !== 'assistant' || message.done !== true) {
			return false;
		}

		const payloadCalls = Array.isArray(payloadToolCalls) ? payloadToolCalls.filter(Boolean) : [];
		const blockCalls = extractToolCallsFromContentBlocks(payloadContentBlocks);
		const messageBlockCalls = extractToolCallsFromContentBlocks(message.contentBlocks);
		const allRecordedCalls = reconcileRecordedToolCalls(
			payloadCalls,
			blockCalls,
			messageBlockCalls
		);

		let changed = false;
		if (allRecordedCalls.length > 0) {
			if (!recordedToolCallArraysEqual(message.tool_calls, allRecordedCalls)) {
				message.tool_calls = allRecordedCalls;
				changed = true;
			}

			if (typeof message.content === 'string') {
				const strippedContent = stripUnverifiedToolClaimNote(message.content);
				if (strippedContent !== message.content) {
					message.content = strippedContent;
					changed = true;
				}
			}

			if (message.unverified_tool_claim) {
				message.unverified_tool_claim = false;
				changed = true;
			}
			return changed;
		}

		const content = typeof message.content === 'string' ? message.content : '';
		if (!looksLikeUnverifiedToolExecutionClaim(content)) {
			return changed;
		}

		if (!content.includes(UNVERIFIED_TOOL_CLAIM_NOTE)) {
			message.content = `${content}${UNVERIFIED_TOOL_CLAIM_NOTE}`;
			changed = true;
		}

		if (message.unverified_tool_claim !== true) {
			message.unverified_tool_claim = true;
			changed = true;
		}

		return changed;
	};

	const applyStreamingUsageUpdate = (
		message: any,
		usage: Record<string, unknown>,
		force = false
	): boolean => {
		if (!message?.id) return false;

		const messageId = message.id as string;
		const state =
			streamUsageStateByMessageId[messageId] ??
			(streamUsageStateByMessageId[messageId] = { lastAppliedAt: 0 });

		// Streaming usage payloads are cumulative snapshots for the active turn.
		// Merge by max so duplicate terminal usage events cannot double-count tokens.
		const mergedUsage = mergePromptUsage(
			(message.usage ?? undefined) as Record<string, unknown> | undefined,
			usage,
			'max'
		);

		if (!hasMeaningfulUsageChange(message.usage as Record<string, unknown> | undefined, mergedUsage)) {
			return false;
		}

		const now = Date.now();
		if (force || now - state.lastAppliedAt >= STREAM_USAGE_UPDATE_INTERVAL_MS) {
			message.usage = mergedUsage;
			state.lastAppliedAt = now;
			state.pendingUsage = undefined;
			noteVisibleAssistantProgress(message);
			bumpContextTokensVersion();
			return true;
		}

		state.pendingUsage = mergedUsage;
		return false;
	};

	const flushPendingStreamingUsageUpdate = (message: any, force = false): boolean => {
		if (!message?.id) return false;

		const messageId = message.id as string;
		const state = streamUsageStateByMessageId[messageId];
		if (!state?.pendingUsage) return false;

		const now = Date.now();
		if (!force && now - state.lastAppliedAt < STREAM_USAGE_UPDATE_INTERVAL_MS) {
			return false;
		}

		message.usage = state.pendingUsage;
		state.pendingUsage = undefined;
		state.lastAppliedAt = now;
		noteVisibleAssistantProgress(message);
		bumpContextTokensVersion();
		return true;
	};

	const estimateWordCount = (content: string): number => {
		const trimmed = content.trim();
		if (!trimmed) return 0;
		return trimmed.split(/\s+/).length;
	};

	const estimateTokenCount = (content: string, wordCount: number): number => {
		return Math.max(Math.round(content.length / 4), Math.round(wordCount * 1.33));
	};

	const formatSignedMetric = (value: number): string => {
		return value >= 0 ? `+${value}` : `${value}`;
	};

	const STREAM_PERF_LOGGING_STORAGE_KEY = 'stream_perf_logging_enabled';

	const resolveStreamPerfLoggingEnabled = (): boolean => {
		if (typeof window === 'undefined') return false;

		// Strict opt-in only. Older debug keys are intentionally ignored so
		// stream perf logging is disabled by default unless explicitly enabled.
		const rawValue = localStorage.getItem(STREAM_PERF_LOGGING_STORAGE_KEY);
		if (rawValue === null) {
			return false;
		}

		const normalized = rawValue.trim().toLowerCase();
		return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
	};

	const stopStreamPerfLoggerIfIdle = () => {
		if (Object.keys(streamRenderPerfStateByMessageId).length > 0) {
			return;
		}

		if (streamPerfLogInterval !== null) {
			clearInterval(streamPerfLogInterval);
			streamPerfLogInterval = null;
		}
	};

	const clearStreamingRenderPerfState = (messageId: string | undefined | null) => {
		if (!messageId) return;
		delete streamRenderPerfStateByMessageId[messageId];
		stopStreamPerfLoggerIfIdle();
	};

	const logStreamingRenderPerformance = () => {
		if (!streamPerfLoggingEnabled) return;

		const now = Date.now();
		const messageIds = Object.keys(streamRenderPerfStateByMessageId);

		for (const messageId of messageIds) {
			const state = streamRenderPerfStateByMessageId[messageId];
			const message = history?.messages?.[messageId];
			const content = typeof message?.content === 'string' ? message.content : '';
			const words = estimateWordCount(content);
			const approxTokens = estimateTokenCount(content, words);

			const elapsedMs = Math.max(1, now - state.lastLoggedAt);
			const elapsedSeconds = elapsedMs / 1000;

			const deltaChars = state.lastCommittedChars - state.lastLoggedChars;
			const deltaWords = words - state.lastLoggedWords;
			const deltaTokens = approxTokens - state.lastLoggedTokens;
			const commits = state.commitsSinceLastLog;
			const nonMonotonicSkips = streamContentOrderStateByMessageId[messageId]?.nonMonotonicSkips ?? 0;
			const avgCommitWorkMs = commits > 0 ? state.commitWorkMsSinceLastLog / commits : 0;
			const maxCommitWorkMs = state.maxCommitWorkMsSinceLastLog;
			const scrollOps = state.scrollOpsSinceLastLog;
			const avgScrollWorkMs = scrollOps > 0 ? state.scrollWorkMsSinceLastLog / scrollOps : 0;
			const maxScrollWorkMs = state.maxScrollWorkMsSinceLastLog;

			console.info(
				`[StreamPerf] msg=${messageId.slice(0, 8)} len=${state.lastCommittedChars} chars (~${approxTokens} tok, ${words} words)` +
					` | dChars=${formatSignedMetric(deltaChars)} (${(deltaChars / elapsedSeconds).toFixed(1)}/s)` +
					` | dWords=${formatSignedMetric(deltaWords)} (${(deltaWords / elapsedSeconds).toFixed(1)}/s)` +
					` | dTok≈${formatSignedMetric(deltaTokens)} (${(deltaTokens / elapsedSeconds).toFixed(1)}/s)` +
					` | commits=${commits} (${(commits / elapsedSeconds).toFixed(2)}/s)` +
					` | commitMs(avg/max)=${avgCommitWorkMs.toFixed(1)}/${maxCommitWorkMs.toFixed(1)}` +
					` | scrollMs(avg/max)=${avgScrollWorkMs.toFixed(1)}/${maxScrollWorkMs.toFixed(1)} (${scrollOps} ops)` +
					` | nonMonotonicSkips=${nonMonotonicSkips}`
			);

			state.lastLoggedAt = now;
			state.lastLoggedChars = state.lastCommittedChars;
			state.lastLoggedWords = words;
			state.lastLoggedTokens = approxTokens;
			state.commitsSinceLastLog = 0;
			state.commitWorkMsSinceLastLog = 0;
			state.maxCommitWorkMsSinceLastLog = 0;
			state.scrollOpsSinceLastLog = 0;
			state.scrollWorkMsSinceLastLog = 0;
			state.maxScrollWorkMsSinceLastLog = 0;

			const streamInactive = now - state.lastCommitAt > STREAM_PERF_INACTIVE_TIMEOUT_MS;
			if (message?.done === true || streamInactive) {
				delete streamRenderPerfStateByMessageId[messageId];
				delete streamContentOrderStateByMessageId[messageId];
			}
		}

		stopStreamPerfLoggerIfIdle();
	};

	const ensureStreamPerfLoggerRunning = () => {
		if (!streamPerfLoggingEnabled || streamPerfLogInterval !== null) {
			return;
		}

		streamPerfLogInterval = window.setInterval(() => {
			logStreamingRenderPerformance();
		}, STREAM_PERF_LOG_INTERVAL_MS);
	};

	const noteStreamingRenderCommit = (message: any, commitWorkMs = 0) => {
		if (!streamPerfLoggingEnabled || !message?.id) return;

		const messageId = message.id as string;
		const content = typeof message?.content === 'string' ? message.content : '';
		const now = Date.now();
		const initialWordCount = estimateWordCount(content);

		const state =
			streamRenderPerfStateByMessageId[messageId] ??
				(streamRenderPerfStateByMessageId[messageId] = {
					startedAt: now,
					lastCommitAt: now,
					lastCommittedChars: content.length,
					lastLoggedAt: now,
					lastLoggedChars: content.length,
					lastLoggedWords: initialWordCount,
					lastLoggedTokens: estimateTokenCount(content, initialWordCount),
					commitsSinceLastLog: 0,
					totalCommits: 0,
					commitWorkMsSinceLastLog: 0,
					maxCommitWorkMsSinceLastLog: 0,
					scrollOpsSinceLastLog: 0,
					scrollWorkMsSinceLastLog: 0,
					maxScrollWorkMsSinceLastLog: 0
				});

		state.lastCommitAt = now;
		state.lastCommittedChars = content.length;
		state.commitsSinceLastLog += 1;
		state.totalCommits += 1;
		state.commitWorkMsSinceLastLog += commitWorkMs;
		state.maxCommitWorkMsSinceLastLog = Math.max(state.maxCommitWorkMsSinceLastLog, commitWorkMs);

		ensureStreamPerfLoggerRunning();
	};

	const noteStreamingAutoScrollWork = (
		messageId: string | undefined | null,
		scrollWorkMs: number
	) => {
		if (!streamPerfLoggingEnabled || !messageId) return;

		const state = streamRenderPerfStateByMessageId[messageId];
		if (!state) return;

		state.scrollOpsSinceLastLog += 1;
		state.scrollWorkMsSinceLastLog += scrollWorkMs;
		state.maxScrollWorkMsSinceLastLog = Math.max(state.maxScrollWorkMsSinceLastLog, scrollWorkMs);
	};

	const getStreamingCommitIntervalMs = (_message: any, lastCommitWorkMs = 0): number => {
		// PORTICO_PATCH: Keep cadence consistent over the full stream lifecycle.
		// We no longer ramp intervals by content length. The only backoff is
		// work-driven on slower devices.
		const baseIntervalMs = 16;

		if (lastCommitWorkMs <= 0) {
			return baseIntervalMs;
		}

		// If a commit takes longer than expected, back off proportionally.
		// Multiplier of 3 means: if a commit takes 10ms, interval = 30ms.
		const workMultiplier = 3;
		const workDrivenIntervalMs = Math.ceil(lastCommitWorkMs * workMultiplier);
		return Math.max(baseIntervalMs, Math.min(160, workDrivenIntervalMs));
	};

	const scheduleStreamingMessageCommit = (message: any): boolean => {
		if (!message?.id) return false;

		const messageId = message.id as string;
		const state =
			streamRenderStateByMessageId[messageId] ??
			(streamRenderStateByMessageId[messageId] = {
				timerId: null,
				lastCommittedAt: 0,
				lastCommitWorkMs: 0
			});

		if (state.timerId !== null) {
			return false;
		}

		const now = Date.now();
		const intervalMs = getStreamingCommitIntervalMs(message, state.lastCommitWorkMs);
		const delayMs = Math.max(0, state.lastCommittedAt + intervalMs - now);

		state.timerId = window.setTimeout(() => {
			state.timerId = null;
			const commitStartedAt = performance.now();
			history.messages[messageId] = message;
			history = history;
			state.lastCommittedAt = Date.now();
			// PORTICO_PATCH: Scroll IMMEDIATELY after Svelte renders the commit.
			// tick() resolves after Svelte applies the reactive update to the DOM.
			// This is the ONLY reliable scroll timing — polling intervals and
			// ResizeObservers can miss the window between render and done=true.
			if (autoScroll && messagesContainerElement) {
				tick().then(() => {
					if (autoScroll && messagesContainerElement) {
						messagesContainerElement.scrollTop = 9999999;
					}
				});
			}
			queueMicrotask(() => {
				const commitWorkMs = performance.now() - commitStartedAt;
				state.lastCommitWorkMs = commitWorkMs;
				noteStreamingRenderCommit(message, commitWorkMs);
			});
		}, delayMs);

		return true;
	};

	const flushPendingStreamingMessageCommit = (message: any): boolean => {
		if (!message?.id) return false;

		const messageId = message.id as string;
		const state = streamRenderStateByMessageId[messageId];
		// PORTICO_PATCH: Use != (loose equality) so that both null and undefined
		// are treated as "no pending timer".  The old strict !== null check
		// passed when state was undefined (undefined !== null → true) and then
		// crashed on clearTimeout(state.timerId).
		if (state != null && state.timerId != null) {
			clearTimeout(state.timerId);
			state.timerId = null;
		}
		const commitStartedAt = performance.now();
		history.messages[messageId] = message;
		const commitWorkMs = performance.now() - commitStartedAt;
		if (state) {
			state.lastCommittedAt = Date.now();
			state.lastCommitWorkMs = commitWorkMs;
		}
		// PORTICO_PATCH: Scroll after Svelte renders the flushed commit.
		if (autoScroll && messagesContainerElement) {
			tick().then(() => {
				if (autoScroll && messagesContainerElement) {
					messagesContainerElement.scrollTop = 9999999;
				}
			});
		}
		queueMicrotask(() => {
			const commitTaskMs = performance.now() - commitStartedAt;
			if (state) {
				state.lastCommitWorkMs = commitTaskMs;
			}
			noteStreamingRenderCommit(message, commitTaskMs);
		});
		return true;
	};

	const clearStreamingMessageCommitState = (messageId: string | undefined | null) => {
		if (!messageId) return;

		const state = streamRenderStateByMessageId[messageId];
		if (state) {
			if (state.timerId !== null) {
				clearTimeout(state.timerId);
				state.timerId = null;
			}

			delete streamRenderStateByMessageId[messageId];
		}

		delete streamContentOrderStateByMessageId[messageId];
		delete streamMaxContentLengthByMessageId[messageId];
		clearStreamingRenderPerfState(messageId);
	};

	const clearAllStreamingMessageCommitStates = () => {
		const messageIds = new Set([
			...Object.keys(streamRenderStateByMessageId),
			...Object.keys(streamContentOrderStateByMessageId),
			...Object.keys(streamRenderPerfStateByMessageId),
			// The watchdog merge path records max-length entries without ever
			// scheduling a commit, so sweep this map too or entries leak
			// across chat switches.
			...Object.keys(streamMaxContentLengthByMessageId)
		]);

		for (const messageId of messageIds) {
			clearStreamingMessageCommitState(messageId);
		}
	};

	$: latestContextMessageId = (() => {
		contextTokensVersion;
		return getLatestAssistantMessageId(
			history?.messages as Record<string, any> | undefined,
			history?.currentId
		);
	})();
	$: contextUsage = (() => {
		contextTokensVersion;
		return deriveContextUsage({
			turnSummary: contextTurnSummary,
			historyUsage: getLatestContextUsageFromHistory(
				history?.messages as Record<string, any> | undefined,
				history?.currentId
			)
		}) as Record<string, unknown> | undefined;
	})();
	$: contextTokens = (() => {
		return getDisplayContextTokenCount({
			usage: contextUsage,
			persistedContextTokens,
			persistedMaxContextTokens
		});
	})();

	$: aggregateCumulativeCost = workflowCostMetrics.cost;
	$: aggregateCumulativeCostWithoutCache = workflowCostMetrics.costWithoutCache;
	$: aggregateCumulativeCacheSavings = workflowCostMetrics.cacheSavings;
	$: aggregateCumulativeSavingsRate = workflowCostMetrics.savingsRate;
	$: aggregateCumulativeCachedTokens = workflowCostMetrics.cachedTokens;
	$: aggregateCumulativeCacheReadTokens = workflowCostMetrics.cacheReadTokens;
	$: aggregateCumulativeCacheWriteTokens = workflowCostMetrics.cacheWriteTokens;

	$: {
		history?.messages;
		activeChatId;
		if (chatFirstPaintReady && activeChatId) {
			invalidateSubagentDescendantCache(activeChatId);
		}
		scheduleAggregateWorkflowCostRefresh();
	}

	$: {
		contextTokensVersion;
		history?.messages;
		history?.currentId;
		activeChatId;
		scheduleContextTurnSummaryRefresh();
	}

	$: if (reasoningEffortReady) {
		// Explicit deps so this re-runs when the selection or model catalog changes
		// (seedAgentReasoningEffortDefaults reads them inside a function call, which
		// Svelte's reactivity would not otherwise track).
		void selectedModelIds;
		void $models;
		// Only normalize once the selected model(s) have resolved. While a chat is
		// loading — notably a delegated subagent chat — selectedModelIds is
		// momentarily empty; normalizing against an empty model set would prune the
		// persisted reasoning_effort (index "0"), so the picker would fall back to
		// the low/medium default instead of the effort the chat actually used.
		if (hasResolvedReasoningModelSelection(selectedModelIds)) {
			// Rebuild the index-keyed map from the model-id ledger so each slot
			// reflects ITS model: a slot whose model changed re-seeds from the new
			// agent's configured effort (validated against its allowed options),
			// while values this chat already resolved travel with their model.
			// Both assignments are signature-guarded so the reactive reaches a
			// fixed point instead of retriggering itself.
			const rebuilt = rebuildReasoningEffortSelectionState({
				ledger: reasoningEffortLedger,
				modelIds: selectedModelIds,
				configuredEffortByModelId:
					getConfiguredAgentReasoningEffortByModelId(selectedModelIds),
				allowedOptionsByModelId:
					getAllowedReasoningEffortOptionsByModelId(selectedModelIds)
			});
			if (JSON.stringify(rebuilt.ledger) !== JSON.stringify(reasoningEffortLedger)) {
				reasoningEffortLedger = rebuilt.ledger;
			}
			if (
				reasoningEffortByModelSignature(rebuilt.reasoningEffortByModel) !==
				reasoningEffortByModelSignature(reasoningEffortByModel)
			) {
				setReasoningEffortState({
					nextMap: rebuilt.reasoningEffortByModel
				});
			}
		}
	}

	let showCommands = false;

	let generating = false;
	let generationController = null;

	// Keep chat-stream logging disabled by default; high-frequency logs degrade UI performance on long streams.
	const DEBUG_CHAT_EVENTS = false;
	const DEBUG_STREAM_CHUNKS = false;

	// PORTICO PATCH (landing starfield): single source of truth for the
	// landing-placeholder branch in the template — the {#if} below consumes
	// the inverse, so the starfield layer can never drift out of sync with
	// the placeholder. Suppressed over custom background images and in
	// delegated-subagent views.
	// Tiled panes (primary included) always use conversation view — a landing
	// placeholder inside a tile would strand the shared composer bar empty.
	$: showLandingPlaceholder =
		!multiChatActiveLocal &&
		!(
			($settings?.landingPageMode === 'chat' && !$selectedFolder) ||
			Object.keys(history?.messages ?? {}).length > 0
		);
	$: hasCustomChatBackground = Boolean(
		($selectedFolder && $selectedFolder?.meta?.background_image_url) ||
			($settings?.backgroundImageUrl ?? $config?.license_metadata?.background_image_url ?? null)
	);
	$: showLandingStarfield =
		showLandingPlaceholder && !hasCustomChatBackground && !delegatedSubagentView;

	let rateLimitOverlayActive = false;
	let rateLimitOverlayAttempt = 0;
	let rateLimitOverlayMaxAttempts = 0;
	let rateLimitOverlayRemainingMs = 0;
	let rateLimitOverlayPhase = 'waiting';
	let rateLimitOverlayMessageId: string | null = null;
	let rateLimitOverlayInterval: ReturnType<typeof setInterval> | null = null;
	let rateLimitOverlayCanceling = false;

	// Portico: Stream watchdog - detects stalled streaming when socket events stop arriving
	let streamWatchdogInterval: ReturnType<typeof setInterval> | null = null;
	let lastSocketEventTime: Record<string, number> = {}; // messageId -> timestamp
	let lastVisibleProgressTimeByMessageId: Record<string, number> = {};
	let lastInvisibleProgressPollTimeByMessageId: Record<string, number> = {};
	const DETACHED_SUBAGENT_RECONCILE_INTERVAL_MS = 5000;
	const DETACHED_SUBAGENT_RECONCILE_BUDGET_MS = 2 * 60 * 60 * 1000;
	let detachedSubagentReconcileTimer: ReturnType<typeof setTimeout> | null = null;
	let detachedSubagentReconcilePromise: Promise<void> | null = null;
	let detachedSubagentReconcileAbortController: AbortController | null = null;
	let detachedSubagentReconcileChatId = '';
	let detachedSubagentReconcileGeneration = 0;
	let detachedSubagentReconcileStartedAt = 0;
	let detachedSubagentLastLiveEventAt = 0;
	let detachedSubagentTerminalReconcilePending = false;
	let composerStreamingFallbackLoggedMessageIds = new Set<string>();
	let composerStreamingStateVersion = 0;
	let composerStreamingState: ComposerStreamingState = {
		isStreaming: false,
		currentTurnAssistantIds: [],
		visibleMessageIds: [],
		visibleTailMessageId: null,
		usedActiveTaskFallback: false
	};

	$: rateLimitOverlaySeconds = Math.max(0, Math.ceil(rateLimitOverlayRemainingMs / 1000));

	let chat = null;
	let tags = [];

	let history = {
		messages: {},
		currentId: null
	};

	const STREAM_USAGE_UPDATE_INTERVAL_MS = 250;
	const streamUsageStateByMessageId: Record<
		string,
		{ lastAppliedAt: number; pendingUsage?: Record<string, unknown> }
	> = {};
	const streamRenderStateByMessageId: Record<
		string,
		{
			timerId: ReturnType<typeof setTimeout> | null;
			lastCommittedAt: number;
			lastCommitWorkMs: number;
		}
	> = {};
	const streamContentOrderStateByMessageId: Record<
		string,
		{ sawDeltaChunk: boolean; nonMonotonicSkips: number }
	> = {};
	const streamMaxContentLengthByMessageId: Record<string, number> = {};
	const streamRenderPerfStateByMessageId: Record<
		string,
		{
			startedAt: number;
			lastCommitAt: number;
			lastCommittedChars: number;
			lastLoggedAt: number;
			lastLoggedChars: number;
			lastLoggedWords: number;
			lastLoggedTokens: number;
			commitsSinceLastLog: number;
			totalCommits: number;
			commitWorkMsSinceLastLog: number;
			maxCommitWorkMsSinceLastLog: number;
			scrollOpsSinceLastLog: number;
			scrollWorkMsSinceLastLog: number;
			maxScrollWorkMsSinceLastLog: number;
		}
	> = {};
	let streamPerfLogInterval: ReturnType<typeof setInterval> | null = null;
	let streamPerfLoggingEnabled = false;

	const clearStreamingProgressState = (messageId: string | undefined | null) => {
		if (!messageId) return;
		delete lastSocketEventTime[messageId];
		delete lastVisibleProgressTimeByMessageId[messageId];
		delete lastInvisibleProgressPollTimeByMessageId[messageId];
		composerStreamingFallbackLoggedMessageIds.delete(messageId);
		composerStreamingStateVersion += 1;
	};

	const CONTENTS_REFRESH_DEBOUNCE_MS = 120;
	let contentsRefreshTimer: ReturnType<typeof setTimeout> | null = null;

	let autoScrollObserver: ResizeObserver | null = null;
	let autoScrollInterval: ReturnType<typeof setInterval> | null = null;
	let autoScrollProgrammaticGuardUntil = 0;
	let messagesContentElement: HTMLElement;

	let taskIds = null;
	let pendingWork: PendingWorkState = emptyPendingWorkState();
	let pendingWorkLoaded = false;
	let editingPendingWork:
		| {
				kind: 'steer' | 'queue';
				id: string;
		  }
		| null = null;
	let queuedEditCursorId: string | null = null;
	let backendStartedTurnReconcilePromise: Promise<boolean> | null = null;
	let reconciledBackendStartedMessageIds = new Set<string>();
	let protectedBackgroundTurnMessageIds = new Set<string>();
	let backgroundTurnInsertionPayloadsByMessageId = new Map<string, Record<string, any>>();
	let lastReportedTabBusy = false;
	let lastReportedTabPhase = 'idle';
	let lastReportedTabChatId = '';
	let lastReportedTabTitle = '';
	let lastReportedTabModelSignature = '';
	let lastReportedTabMultiChat = false;
	// Activity state is chat-scoped and becomes publishable only after the
	// selected chat's history and task snapshot have been reconciled. Keeping
	// this separate from activeChatId prevents a route change from projecting the
	// previous chat's task/history state onto the newly selected chat.
	let tabActivityChatId = '';

	// PORTICO PATCH (N-012): chat-scoped pending MCP tool confirmations rendered
	// as chips above the chat input. Each entry corresponds to one
	// `chat:tool_confirmation` event from the backend gate; entries drop on
	// rejection, on user submit (the gate resolves the reply server-side), and
	// on chat switch. The gate's in-memory state on the server is the source of
	// truth — this list is purely a re-projection for rendering.
	// Phase 3: pendingToolConfirmations holds chips of any kind
	// (tool_confirmation default, plus clarification chips proposed by
	// e.g. the scheduling executor for out-of-scope decisions). The
	// list name keeps the historical identifier so existing test
	// anchors and renderer paths don't churn.
	type PendingToolConfirmation = {
		hash: string;
		tool_name: string;
		mcp: string;
		summary: string;
		args_preview: Record<string, unknown>;
		// Generic chip fields (Phase 3). Tool-confirmation chips carry
		// kind='tool_confirmation' (or omit it for back-compat); clarification
		// chips carry kind='clarification' plus the proposer-supplied
		// option set. ``options`` is rendered by ToolConfirmationChip.svelte.
		kind?: 'tool_confirmation' | 'clarification';
		prompt?: string;
		options?: Array<{ id: string; label: string; style?: 'primary' | 'secondary' | 'danger' }>;
		allow_freeform?: boolean;
		context?: Record<string, unknown>;
		state:
			| 'pending'
			| 'approved'
			| 'cancelled'
			| 'modify-submitted'
			| 'resolved';
		modify_payload?: string;
		// Clarification chips track which option the user picked so the
		// terminal "Resolved: <label>" badge can show it.
		resolved_option_id?: string;
		freeform_payload?: string;
	};
	let pendingToolConfirmations: PendingToolConfirmation[] = [];
	let pendingChipNotificationTimer: ReturnType<typeof setTimeout> | null = null;
	const lastPendingChipNotificationSignature = new Map<string, string>();

	// PORTICO PATCH (N-012): true once a batch-send chat turn is in flight
	// for the current resolution batch. Prevents the auto-fire effect from
	// firing twice if the user clicks chips while a previous batch's
	// stream is still draining. Cleared when the batch turn's stream
	// settles (clearGenerationStateIfIdle / applyImmediateStopState /
	// finalizeAssistantErrorMessage).
	let toolConfirmationBatchInFlight = false;

	function handleToolConfirmationChipDecision(event: CustomEvent) {
		// Wired into MessageInput.svelte's <ToolConfirmationChip on:decision>.
		// Updates the local chip's state to match what the chip already
		// committed to the backend via REST, then triggers an auto-fire
		// check: when every chip is terminal, kick a single batch-send
		// chat turn so the model can act on all decisions at once.
		//
		// Phase 3: the event carries both the legacy ``decision`` field
		// (still populated for tool-confirmation chips so existing
		// approve/cancel/modify-submitted state machine keeps working) and
		// the generic ``option_id`` (always populated; for clarification
		// chips it's the only meaningful identifier). We branch on chip
		// kind to map either vocabulary to the right state.
		const detail = event?.detail;
		if (!detail || typeof detail !== 'object') return;
		const {
			decision,
			option_id: optionId,
			hash,
			payload,
			ok
		} = detail as {
			decision: 'approve' | 'cancel' | 'modify' | '';
			option_id: string;
			hash: string;
			payload?: string;
			ok?: boolean;
		};
		if (!ok) {
			// Backend rejected the resolve (unknown hash, ACL miss, malformed).
			// Leave the chip in pending state so the user can retry; the
			// chip's own UI already cleared its inflight flag.
			console.warn('[Chat] tool-confirmation REST resolve failed for hash', hash);
			return;
		}
		pendingToolConfirmations = pendingToolConfirmations.map((chip) => {
			if (chip.hash !== hash) return chip;
			const kind = chip.kind ?? 'tool_confirmation';
			if (kind === 'tool_confirmation') {
				// Round 4 hotfix: branch on ``option_id`` (the canonical
				// chip-button identity) instead of the legacy ``decision``
				// field. ``decision`` is only populated for the historical
				// approve/cancel/modify trio, so options added later
				// (``always_allow``, future per-tool options, …) would
				// silently fall into the ``modify`` else-branch and the
				// chip would render as "Modify". With option_id-based
				// branching every declared option maps to the correct
				// terminal state.
				if (optionId === 'approve' || optionId === 'always_allow') {
					return { ...chip, state: 'approved' };
				}
				if (optionId === 'cancel') {
					return { ...chip, state: 'cancelled' };
				}
				if (optionId === 'modify') {
					return {
						...chip,
						state: 'modify-submitted',
						modify_payload: payload ?? ''
					};
				}
				// Defensive: an unknown option_id on a tool-confirmation
				// chip should leave the chip in pending state so the
				// user can pick a real button. The backend gate already
				// rejects unknown option ids with ``gate_bypass_attempted``,
				// so this branch is genuinely unreachable in normal use.
				return chip;
			}
			// Clarification chips collapse all options to the generic
			// ``resolved`` terminal state and stash the option id +
			// freeform payload so the badge can render "Resolved: Block".
			return {
				...chip,
				state: 'resolved',
				resolved_option_id: optionId,
				freeform_payload: payload ?? ''
			};
		});

		// Auto-fire if every chip has reached a terminal state. We DON'T
		// auto-fire if a batch is already in flight (race protection: a
		// stream from a previous batch could still be processing) or if
		// pendingToolConfirmations is empty (defensive — should never happen
		// given the chip-decision event implies at least one chip exists).
		if (
			pendingToolConfirmations.length === 0 ||
			toolConfirmationBatchInFlight ||
			generating
		) {
			return;
		}
		const allTerminal = pendingToolConfirmations.every(
			(chip) => chip.state !== 'pending'
		);
		if (allTerminal) {
			toolConfirmationBatchInFlight = true;
			fireToolConfirmationBatchSend();
		}
	}

	function buildBatchResolutionUserMessage(
		chips: PendingToolConfirmation[]
	): string {
		// Build a concise human-readable summary of what the user just
		// resolved, used as the visible user-message body on the auto-
		// fired batch-send turn. The model receives a richer hidden
		// system note (see ``_inject_batch_resolution_note`` in the
		// backend); this string is what shows in the chat scrollback.
		const parts: string[] = [];
		for (const chip of chips) {
			const kind = chip.kind ?? 'tool_confirmation';
			const label = chip.tool_name || 'tool';
			if (kind === 'tool_confirmation') {
				if (chip.state === 'approved') {
					parts.push(`Confirmed ${label}`);
				} else if (chip.state === 'cancelled') {
					parts.push(`Cancelled ${label}`);
				} else if (chip.state === 'modify-submitted') {
					const payload = (chip.modify_payload || '').trim();
					parts.push(payload ? `Modify ${label}: ${payload}` : `Modify ${label}`);
				}
			} else if (chip.state === 'resolved') {
				// Clarification chip — surface the chosen option label
				// (or id as a fallback) so chat scrollback honestly
				// represents the user's runtime decision.
				const optionLabel =
					chip.options?.find((opt) => opt.id === chip.resolved_option_id)
						?.label ??
					chip.resolved_option_id ??
					'option';
				const freeform = (chip.freeform_payload || '').trim();
				parts.push(
					freeform
						? `Selected ${optionLabel}: ${freeform}`
						: `Selected ${optionLabel}`
				);
			}
		}
		return parts.length > 0 ? parts.join('; ') : 'Confirmed.';
	}

	async function fireToolConfirmationBatchSend() {
		// Submit a synthetic user turn so the chat completion pipeline runs
		// and the backend's ``_resolve_pending_tool_confirmations`` drains
		// the resolution log into a hidden system note for the model. The
		// VISIBLE message text is a compact summary so chat scrollback
		// honestly reflects what the user just did with the chips.
		try {
			await tick();
			const summary = buildBatchResolutionUserMessage(pendingToolConfirmations);
			await submitPrompt(summary, { _toolConfirmationBatchSend: true });
		} catch (error) {
			console.error('[Chat] auto-fire batch-send failed', error);
			toolConfirmationBatchInFlight = false;
		}
	}

	const setTaskIds = (nextTaskIds: string[] | null) => {
		taskIds = nextTaskIds;
		composerStreamingStateVersion += 1;
	};

	const appendTaskId = (taskId: string | null | undefined) => {
		if (!taskId) return;
		taskIds = Array.isArray(taskIds) ? [...taskIds, taskId] : [taskId];
		composerStreamingStateVersion += 1;
	};

	const getChatNotificationModelIdentity = (
		preferredModelId: unknown = null
	): ChatNotificationModelIdentity | null => {
		if (preferredModelId) {
			return resolveNotificationModelIdentityForId(preferredModelId, $models ?? []);
		}
		return resolveChatNotificationModelIdentity({
			chatRow: {
				chat: {
					history,
					models: selectedModelIds
				}
			},
			modelCatalog: $models ?? [],
			fallbackModelIds: atSelectedModel?.id ? [atSelectedModel.id] : selectedModelIds
		});
	};

	const stableNotificationDigest = (value: unknown): string => {
		const input = typeof value === 'string' ? value : JSON.stringify(value ?? null);
		let hash = 0x811c9dc5;
		for (let index = 0; index < input.length; index += 1) {
			hash ^= input.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193);
		}
		return (hash >>> 0).toString(16).padStart(8, '0');
	};

	const notifyNativeChatStatus = (
		type: string,
		details: {
			chatId?: string;
			notificationKey?: string;
			itemCount?: number;
			modelId?: string | null;
		} = {}
	) => {
		if (!browser || typeof window === 'undefined') return;
		const notify = (window as any)?.webviewHost?.notifyChatStatus;
		const currentChatId = String(details.chatId || activeChatId || chatIdProp || '').trim();
		if (typeof notify !== 'function' || !currentChatId) return;

		void Promise.resolve(
			notify({
				type,
				chatId: currentChatId,
				chatTitle: String($chatTitle || '').trim() || 'New Chat',
				notificationKey: String(details.notificationKey || '').trim(),
				itemCount: details.itemCount,
				modelIdentity: getChatNotificationModelIdentity(details.modelId)
			})
		).catch((error) => {
			console.warn('[Chat] Failed to show native chat notification:', error);
		});
	};

	const schedulePendingChipNotifications = (targetChatId: string, modelId: string | null) => {
		if (pendingChipNotificationTimer !== null) {
			clearTimeout(pendingChipNotificationTimer);
		}
		pendingChipNotificationTimer = setTimeout(() => {
			pendingChipNotificationTimer = null;
			// Instance-local: tiles never set the global store.
			const currentChatId = String(activeChatId || chatIdProp || '').trim();
			if (!targetChatId || currentChatId !== targetChatId) return;

			for (const kind of ['tool_confirmation', 'clarification'] as const) {
				const pending = pendingToolConfirmations.filter(
					(chip) => (chip.kind ?? 'tool_confirmation') === kind && chip.state === 'pending'
				);
				if (pending.length === 0) continue;
				const signature = pending.map((chip) => chip.hash).filter(Boolean).sort().join('|');
				const signatureKey = `${targetChatId}:${kind}`;
				if (!signature || lastPendingChipNotificationSignature.get(signatureKey) === signature) {
					continue;
				}
				lastPendingChipNotificationSignature.set(signatureKey, signature);
				notifyNativeChatStatus(
					kind === 'clarification' ? 'clarification' : 'tool-confirmation',
					{
						chatId: targetChatId,
						itemCount: pending.length,
						modelId,
						notificationKey: `${kind}:${targetChatId}:${stableNotificationDigest(signature)}`
					}
				);
			}
		}, 150);
	};

	const reportTabActivity = (
		busy: boolean,
		phase: string,
		currentChatId = '',
		currentTitle = ''
	) => {
		if (!browser || typeof window === 'undefined') {
			return;
		}

		const normalizedChatId = String(currentChatId || '').trim();
		const normalizedTitle = String(currentTitle || $chatTitle || '').trim() || 'New Chat';
		const modelIdentity = getChatNotificationModelIdentity(selectedModelIds?.[0] || null);
		const modelSignature = JSON.stringify(modelIdentity ?? null);
		if (
			lastReportedTabBusy === busy &&
			lastReportedTabPhase === phase &&
			lastReportedTabChatId === normalizedChatId &&
			lastReportedTabTitle === normalizedTitle &&
			lastReportedTabModelSignature === modelSignature &&
			lastReportedTabMultiChat === multiChatActiveLocal
		) {
			return;
		}

		lastReportedTabBusy = busy;
		lastReportedTabPhase = phase;
		lastReportedTabChatId = normalizedChatId;
		lastReportedTabTitle = normalizedTitle;
		lastReportedTabModelSignature = modelSignature;
		lastReportedTabMultiChat = multiChatActiveLocal;
		window.webviewHost?.reportTabActivity?.({
			busy,
			phase,
			chatId: normalizedChatId,
			title: normalizedTitle,
			modelIdentity,
			// Multi-chat tiling: shell-side artifact routing forces windowed-
			// only behavior for tabs where a tiled view is active.
			multiChat: multiChatActiveLocal
		});
	};

	const clearFailedChatLoadActivityState = () => {
		tabActivityChatId = '';
		setTaskIds(null);
		generating = false;
		generationController?.abort();
		generationController = null;
		clearRateLimitOverlay();
		stopStreamWatchdog();
		clearAllStreamingMessageCommitStates();
		composerStreamingFallbackLoggedMessageIds.clear();
	};

	$: if (!isTile) {
		// One activity channel exists per TAB: only the single/primary
		// instance reports; a tile reporting its own busy state would flap
		// the tab's registry entry against the primary's.
		const currentChatId = String(activeChatId || chatIdProp || '').trim();
		const hasActiveTasks = Array.isArray(taskIds) && taskIds.length > 0;
		const busy = composerStreamingState.isStreaming;
		const phase = busy
			? generating
				? 'generating'
				: hasActiveTasks
					? 'tasks'
					: 'generating'
			: 'idle';
		// The tab icon tracks the SELECTED model: reference the selector and
		// catalog so their changes re-emit (identity is resolved inside
		// reportTabActivity; its signature dedupe makes redundant runs free).
		selectedModelIds;
		$models;
		multiChatActiveLocal;
		if (currentChatId && tabActivityChatId === currentChatId) {
			reportTabActivity(
				busy,
				phase,
				currentChatId,
				String($chatTitle || '').trim()
			);
		} else if (!busy) {
			// Landing page (chatId '') and chats that never claimed tab
			// activity still report idle so the tab icon follows the selector.
			reportTabActivity(false, 'idle', currentChatId, String($chatTitle || '').trim());
		}
	}

	// Multi-chat tiles are monitoring surfaces: when a NEW turn starts, re-arm
	// stickiness and jump to the live tail. While streaming, the user may
	// scroll up to read — that disarms following (standard behavior) and we
	// deliberately do NOT fight it. The end-of-stream bottom snap fires only
	// if the user was still following.
	let tileWasStreaming = false;
	$: if (isTile) {
		const tileStreaming = composerStreamingState.isStreaming;
		if (tileStreaming && !tileWasStreaming) {
			autoScroll = true;
			scrollMessagesContainerToBottom();
		}
		if (tileWasStreaming && !tileStreaming && autoScroll) {
			void scrollToBottom();
		}
		tileWasStreaming = tileStreaming;
	}

	// Multi-chat: each tile publishes its live composer-relevant state for the
	// container and the primary composer (streaming hints, steer/queue routing,
	// models/effort/fast-mode/params for cross-pane request_context, context
	// tokens + cost + capabilities for the focus-swapped widgets). Event-driven
	// reactive write, no timers; the signature dedupe keeps stream commits from
	// churning the store. Every input is referenced textually so Svelte tracks
	// them as dependencies of this block.
	let lastPublishedPaneRuntimeSignature = '';
	$: if (isTile && chatIdProp) {
		const publishedRuntime = buildPaneRuntimeSnapshot({
			isStreaming: composerStreamingState.isStreaming,
			selectedModelIds: selectedModels,
			pendingWork,
			title: localPaneTitle,
			reasoningEffortByModel,
			resolvedReasoningEffortByModel: getResolvedReasoningEffortByModelSnapshot(),
			reasoningEffortReady,
			fastModeEnabled,
			params,
			contextTokens,
			costMetrics: workflowCostMetrics,
			activeCapabilities
		});
		const signature = paneRuntimeSignature(publishedRuntime);
		if (signature !== lastPublishedPaneRuntimeSignature) {
			lastPublishedPaneRuntimeSignature = signature;
			multiChatPaneRuntime.update((runtime) => ({
				...runtime,
				[chatIdProp]: publishedRuntime
			}));
		}
	}

	// Multi-chat write-back: composer-settings edits made while this tile is
	// focused arrive as commands and are applied through the SAME handlers a
	// direct visit would use, so persistence (chat-state service, scoped chat
	// update) lands under the tile's own chat id and the runtime republishes.
	let paneCommandsUnsubscribe: (() => void) | null = null;
	let lastAppliedPaneCommandSeq = 0;
	const applyPaneCommand = (command: PaneCommand) => {
		if (command.type === 'set-fast-mode') {
			handleFastModeToggle(command.payload?.enabled === true);
			return;
		}
		if (command.type === 'set-reasoning-effort') {
			handleReasoningEffortSelection({
				modelIndex: command.payload?.modelIndex ?? '',
				value: command.payload?.value ?? ''
			});
			return;
		}
		if (command.type === 'set-models') {
			const nextModelIds = Array.isArray(command.payload?.modelIds)
				? command.payload.modelIds.filter(
						(modelId): modelId is string => typeof modelId === 'string' && modelId.length > 0
					)
				: [];
			if (nextModelIds.length === 0) return;
			if (JSON.stringify(nextModelIds) === JSON.stringify(selectedModels)) return;
			// The selectedModelIds watcher reseeds tools/filters/defaults exactly
			// like a normal model switch would.
			selectedModels = nextModelIds;
			// Scoped merge-persist for reload durability: tiles never run the
			// whole-chat saves that normally carry the models field.
			const persistChatId = activeChatId || chatIdProp;
			if (persistChatId) {
				void updateChatById(localStorage.token, persistChatId, {
					models: nextModelIds
				}).catch((error) => {
					console.error('[MultiChat] Failed to persist pane model change:', error);
				});
			}
		}
	};

	// Chat Input
	let prompt = '';
	let chatFiles = [];
	let files = [];
	let params = {};

	$: if (chatIdProp) {
		navigateHandler();
	}

	const hasActiveGenerationTask = () => {
		if (generating) return true;
		return Array.isArray(taskIds) && taskIds.length > 0;
	};

	const navigateHandler = async () => {
		paneLoadError = false;
		const targetChatId = String(chatIdProp ?? '').trim();
		const routeSubagentHint = isDelegatedSubagentRoute($page.url.searchParams);
		hydratedDelegatedSubagentView = false;
		const isDelegatedSubagentLoad = () =>
			routeSubagentHint || hydratedDelegatedSubagentView;
		stopDetachedSubagentReconciler();
		const generation = ++chatLoadGeneration;
		// Detach the view from the previous chat's local activity without
		// reporting a terminal transition. The main-process registry owns that
		// background lifecycle until an authoritative completion arrives.
		tabActivityChatId = '';
		setTaskIds(null);
		chatLoadAbortController?.abort();
		const abortController = new AbortController();
		chatLoadAbortController = abortController;
		chatLoadStartedAt = performance.now();
		chatFirstPaintReady = false;
		chatRichContentReady = false;
		subagentToolCallDetails.set({});
		const startMark = `portico:chat-load:${generation}:start`;
		performance.clearMarks(startMark);
		performance.mark(startMark);

		if (activeChatId && editingPendingWork?.kind === 'steer') {
			void persistEditingPendingSteer({ nextStatus: 'editing' });
		}
		if (activeChatId && editingPendingWork?.kind === 'queue') {
			void persistEditingQueuedPrompt({ nextStatus: 'queued' });
		}

		loading = true;
		if (isDelegatedSubagentLoad()) {
			setDetachedSubagentStatus('loading');
		} else {
			detachedSubagentLoadError = false;
		}
		clearRateLimitOverlay();
		stopStreamWatchdog(); // Portico: Clean up watchdog when navigating away
		closeDebugMonitorSocket();
		clearDebugMonitorState();
		clearAllStreamingMessageCommitStates();
		forceStoppedMessageIds.clear();
		persistedContextTokens = 0;
		persistedMaxContextTokens = 0;

		prompt = '';
		messageInput?.setText('');

		files = [];
		selectedToolIds = [];
		selectedFilterIds = [];
		clearActiveCapabilities();
		resetReasoningEffortState({ ready: false });
		webSearchEnabled = false;
		imageGenerationEnabled = false;
		editingPendingWork = null;
		queuedEditCursorId = null;
		backendStartedTurnReconcilePromise = null;
		reconciledBackendStartedMessageIds = new Set<string>();
		protectedBackgroundTurnMessageIds = new Set<string>();
		backgroundTurnInsertionPayloadsByMessageId = new Map<string, Record<string, any>>();
		// PORTICO PATCH (N-012): drop any pending tool-confirmation chips and
		// any staged auto-fire when switching chats — the gate's per-chat
		// state stays server-side, and a new chat must not inherit the
		// previous chat's pending entries or batch resolutions.
		pendingToolConfirmations = [];
		toolConfirmationBatchInFlight = false;
		applyPendingWorkState(emptyPendingWorkState(targetChatId));

		const storageChatInput = sessionStorage.getItem(
			`chat-input${targetChatId ? `-${targetChatId}` : ''}`
		);

		try {
			if (
				targetChatId &&
				(await loadChat(targetChatId, generation, abortController.signal))
			) {
				if (!isCurrentChatLoad(generation, targetChatId)) return;
				if (isDelegatedSubagentLoad()) {
					setDetachedSubagentStatus('ready', '');
				}
				loading = false;
				await tick();
				if (isDelegatedSubagentLoad()) {
					startDetachedSubagentReconciler(targetChatId, generation);
				}
				window.setTimeout(() => {
					if (isCurrentChatLoad(generation, targetChatId)) {
						scrollToBottom();
					}
				}, 0);

				await reportChatLoadReady(generation, targetChatId);
				if (!isCurrentChatLoad(generation, targetChatId)) return;

				void loadDeferredChatState(targetChatId, generation).catch((error) => {
					if (isCurrentChatLoad(generation, targetChatId)) {
						console.warn('[Chat] Failed to hydrate deferred chat state:', error);
					}
				});

				if (storageChatInput) {
					try {
						const input = JSON.parse(storageChatInput);

						applyDraftInput(input);
					} catch (e) {}
				} else {
					await setDefaults();
				}
				if (!isCurrentChatLoad(generation, targetChatId)) return;

				if (!isTile) {
					const chatInput = document.getElementById('chat-input');
					chatInput?.focus();
				}
			} else if (!isCurrentChatLoad(generation, targetChatId)) {
				return;
			} else if (isDelegatedSubagentLoad()) {
				if (!detachedSubagentLoadError && detachedSubagentStatus !== 'pending') {
					setDetachedSubagentStatus('error');
				}
				await tick();
				loading = false;
			} else if (isTile) {
				// A failed pane shows an inline error card; it must never
				// navigate the whole tiled page away.
				paneLoadError = true;
				loading = false;
			} else {
				await goto('/');
			}
		} catch (error) {
			if (
				abortController.signal.aborted ||
				!isCurrentChatLoad(generation, targetChatId) ||
				(error instanceof DOMException && error.name === 'AbortError')
			) {
				return;
			}
			clearFailedChatLoadActivityState();
			if (isDelegatedSubagentLoad()) {
				setDetachedSubagentStatus('error');
				console.warn('[Chat] Failed to render delegated subagent chat:', error);
			} else if (isTile) {
				console.error('[Chat] Failed to load tiled pane chat:', error);
				paneLoadError = true;
				loading = false;
			} else {
				console.error('[Chat] Failed to load chat:', error);
				await goto('/');
			}
		} finally {
			if (
				isDelegatedSubagentLoad() &&
				loading &&
				isCurrentChatLoad(generation, targetChatId)
			) {
				if (detachedSubagentStatus === 'loading') {
					setDetachedSubagentStatus('error');
				}
				await tick();
				loading = false;
			}
		}
	};

	const onSelect = async (e) => {
		const { type, data } = e;

		if (type === 'prompt') {
			// Handle prompt selection
			messageInput?.setText(data, async () => {
				if (!($settings?.insertSuggestionPrompt ?? false)) {
					await tick();
					submitPrompt(consumeReviewerWorkflowArming(prompt));
				}
			});
		}
	};

	$: if (selectedModels && chatIdProp !== '') {
		saveSessionSelectedModels();
	}

	const saveSessionSelectedModels = () => {
		const selectedModelsString = JSON.stringify(selectedModels);
		if (
			selectedModels.length === 0 ||
			(selectedModels.length === 1 && selectedModels[0] === '') ||
			sessionStorage.selectedModels === selectedModelsString
		) {
			return;
		}
		sessionStorage.selectedModels = selectedModelsString;
		console.log('saveSessionSelectedModels', selectedModels, sessionStorage.selectedModels);
	};

	let oldSelectedModelIds = [''];
	$: if (JSON.stringify(selectedModelIds) !== JSON.stringify(oldSelectedModelIds)) {
		onSelectedModelIdsChange();
	}

	const onSelectedModelIdsChange = () => {
		resetInput();
		oldSelectedModelIds = JSON.parse(JSON.stringify(selectedModelIds));
	};

	const resetInput = () => {
		selectedToolIds = [];
		selectedFilterIds = [];
		webSearchEnabled = false;
		imageGenerationEnabled = false;
		codeInterpreterEnabled = false;

		if (selectedModelIds.filter((id) => id).length > 0) {
			setDefaults();
		}
	};

	const setDefaults = async () => {
		if (!$tools) {
			tools.set(await getTools(localStorage.token));
		}
		if (!$functions) {
			functions.set(await getFunctions(localStorage.token));
		}
		if (selectedModels.length !== 1 && !atSelectedModel) {
			return;
		}

		const model = atSelectedModel ?? $models.find((m) => m.id === selectedModels[0]);
		if (model) {
			// Set Default Tools
			if (model?.info?.meta?.toolIds) {
				selectedToolIds = [
					...new Set(
						[...(model?.info?.meta?.toolIds ?? [])].filter((id) => $tools.find((t) => t.id === id))
					)
				];
			}

			// Set Default Filters (Toggleable only)
			if (model?.info?.meta?.defaultFilterIds) {
				selectedFilterIds = model.info.meta.defaultFilterIds.filter((id) =>
					model?.filters?.find((f) => f.id === id)
				);
			}

			// Set Default Features
			if (model?.info?.meta?.defaultFeatureIds) {
				if (model.info?.meta?.capabilities?.['image_generation']) {
					imageGenerationEnabled = model.info.meta.defaultFeatureIds.includes('image_generation');
				}

				if (model.info?.meta?.capabilities?.['web_search']) {
					webSearchEnabled = model.info.meta.defaultFeatureIds.includes('web_search');
				}

				if (model.info?.meta?.capabilities?.['code_interpreter']) {
					codeInterpreterEnabled = model.info.meta.defaultFeatureIds.includes('code_interpreter');
				}
			}
		}
	};

	const showMessage = async (message, ignoreSettings = false) => {
		await tick();

		const _chatId = JSON.parse(JSON.stringify(activeChatId));
		let _messageId = JSON.parse(JSON.stringify(message.id));

		let messageChildrenIds = [];
		if (_messageId === null) {
			messageChildrenIds = Object.keys(history.messages).filter(
				(id) => history.messages[id].parentId === null
			);
		} else {
			messageChildrenIds = history.messages[_messageId].childrenIds;
		}

		while (messageChildrenIds.length !== 0) {
			_messageId = messageChildrenIds.at(-1);
			messageChildrenIds = history.messages[_messageId].childrenIds;
		}

		history.currentId = _messageId;

		await tick();
		await tick();
		await tick();

		if (($settings?.scrollOnBranchChange ?? true) || ignoreSettings) {
			const messageElement = document.getElementById(`message-${message.id}`);
			if (messageElement) {
				revealMessageElement(messageElement as HTMLElement, {
					behavior: 'smooth',
					highlight: false
				});
			}
		}

		await tick();
		saveChatHandler(_chatId, history);
	};

	const chatEventHandler = async (event, cb) => {
		if (DEBUG_CHAT_EVENTS) {
			console.debug('[ChatEvent]', event);
		}

		if (event.chat_id === activeChatId) {
			const type = event?.data?.type ?? null;
			const data = event?.data?.data ?? null;
			if (delegatedSubagentView) {
				noteDetachedSubagentLiveEvent(type);
			}

			// Portico: Stream watchdog - record event time for this message
			if (event.message_id) {
				if (!(event.message_id in lastSocketEventTime)) {
					composerStreamingStateVersion += 1;
				}
				lastSocketEventTime[event.message_id] = Date.now();
			}

			// Portico: Handle capabilities updates for real-time display
			if (type === 'chat:capabilities:updated') {
				const capData = data;
				if (capData) {
					applyActiveCapabilities(
						{
							tools: capData.tools || [],
							skills: capData.skills || []
						},
						event.chat_id
					);
					console.log('[Chat] Capabilities updated:', activeCapabilities);
				}
				return;
			}

			if (type === 'chat:pending-work:updated') {
				const nextPendingWork = data?.pending_work;
				if (nextPendingWork) {
					applyPendingWorkState(nextPendingWork);
				}
				return;
			}

			if (type === 'chat:background-turn:inserted') {
				await reconcileBackgroundTurnInsertion(data);
				return;
			}

			if (type === 'chat:rate_limit') {
				handleRateLimitEvent(data, event.message_id);
				return;
			}

			if (type === 'chat:tasks:cancel') {
				applyImmediateStopState('client_disconnect');
				clearGenerationStateIfIdle();
				return;
			}

			if (
				shouldReconcileBackendStartedTurnEvent({
					eventType: type,
					messageId: event.message_id,
					messages: history?.messages
				})
			) {
				await reconcileBackendStartedTurn(event.message_id);
				return;
			}

			let message = history.messages[event.message_id];
			if (message) {
				let shouldAssignMessage = true;
				const isForceStoppedMessage =
					typeof message?.id === 'string' && forceStoppedMessageIds.has(message.id);

				if (isForceStoppedMessage && FORCE_STOP_BLOCKED_EVENT_TYPES.has(type)) {
					if (DEBUG_CHAT_EVENTS) {
						console.debug('[ChatEvent] Ignoring update for locally force-stopped message', {
							messageId: message.id,
							type
						});
					}
					return;
				}

				if (type === 'status') {
					message.statusHistory = upsertStatusHistoryEntry(message?.statusHistory, data);
				} else if (type === 'chat:completion') {
					await chatCompletionEventHandler(data, message, event.chat_id);
					shouldAssignMessage = false;
				} else if (type === 'chat:message:delta' || type === 'message') {
					message.content += data.content;
					recordStreamingContentSnapshot(message?.id, message?.content);
					markStreamingDeltaChunk(message?.id);
					if (data?.content) {
						noteVisibleAssistantProgress(message);
					}
					scheduleStreamingMessageCommit(message);
					shouldAssignMessage = false;
				} else if (type === 'chat:message' || type === 'replace') {
					if (applyMessageContentUpdate(message, data.content, type)) {
						scheduleStreamingMessageCommit(message);
						shouldAssignMessage = false;
					}
				} else if (type === 'chat:message:files' || type === 'files') {
					// PORTICO PATCH: Use spread operator to create new object reference for Svelte reactivity
					message = { ...message, files: mergeDistinctInlineFiles(message.files, data.files) };
				} else if (type === 'chat:message:embeds' || type === 'embeds') {
					message.embeds = data.embeds;
				} else if (type === 'chat:tool_confirmation') {
					// PORTICO PATCH (N-012): per-action MCP write/action confirmation gate.
					// Surface the proposed action as a chip above the chat input
					// (rendered by MessageInput.svelte). The gate
					// (src/patches/backend/open_webui/utils/tool_confirmation_gate.py)
					// holds the pending entry server-side; the user's next message —
					// "yes" / "no" / free-text edit — is what authorizes or cancels.
					//
					// Phase 3: the event payload now also carries kind / prompt /
					// options / allow_freeform / context for generic clarification
					// chips (e.g. scheduled-run out-of-scope decisions). Pre-Phase-3
					// backends omit those fields; the chip component fills them in
					// with tool-confirmation defaults at render time.
					const card: PendingToolConfirmation = {
						hash: String(data?.hash ?? ''),
						tool_name: String(data?.tool_name ?? ''),
						mcp: String(data?.mcp ?? ''),
						summary: String(data?.summary ?? ''),
						args_preview: data?.args_preview ?? {},
						kind: data?.kind === 'clarification' ? 'clarification' : 'tool_confirmation',
						prompt: typeof data?.prompt === 'string' ? data.prompt : '',
						options: Array.isArray(data?.options) ? data.options : undefined,
						allow_freeform:
							typeof data?.allow_freeform === 'boolean'
								? data.allow_freeform
								: undefined,
						context:
							data?.context && typeof data.context === 'object'
								? data.context
								: undefined,
						state: 'pending'
					};
					const existing = pendingToolConfirmations.findIndex((c) => c.hash === card.hash);
					const isNewCard = existing < 0;
					if (existing >= 0) {
						pendingToolConfirmations[existing] = card;
						pendingToolConfirmations = [...pendingToolConfirmations];
					} else {
						pendingToolConfirmations = [...pendingToolConfirmations, card];
					}
					if (isNewCard) {
						schedulePendingChipNotifications(
							String(event.chat_id || '').trim(),
							String(message?.model || '').trim() || null
						);
					}
				} else if (type === 'chat:tool_confirmation_rejected') {
					// Rejections are post-mortem records — keep them anchored to the
					// assistant message that produced the refusal, and also drop any
					// matching pending chip so the input frame doesn't keep showing
					// a stale entry the gate already dismissed.
					const rejection = {
						tool_name: String(data?.tool_name ?? ''),
						reason: String(data?.reason ?? 'rejected')
					};
					if (Array.isArray(message.toolConfirmationRejections)) {
						message.toolConfirmationRejections = [
							...message.toolConfirmationRejections,
							rejection
						];
					} else {
						message.toolConfirmationRejections = [rejection];
					}
					// PORTICO PATCH (N-012): drop the EXACT rejected chip by hash.
					// Filtering by ``tool_name`` clobbers stacked chips that share a
					// name (two ``slack_conversations_add_message`` chips for two
					// different payloads would both vanish on a single rejection).
					// Fall back to tool_name only when an older backend that doesn't
					// emit ``hash`` in the rejection payload is somehow in the
					// pipeline — we should never lose a chip we can identify.
					if (typeof rejection.hash === 'string' && rejection.hash.length > 0) {
						pendingToolConfirmations = pendingToolConfirmations.filter(
							(c) => c.hash !== rejection.hash
						);
					} else {
						pendingToolConfirmations = pendingToolConfirmations.filter(
							(c) => c.tool_name !== rejection.tool_name
						);
					}
				} else if (type === 'chat:message:error') {
					await handleOpenAIError(data?.error ?? data, message);
					shouldAssignMessage = false;
				} else if (type === 'chat:message:follow_ups') {
					message.followUps = data.follow_ups;

					if (autoScroll) {
						scrollToBottom('smooth');
					}
				} else if (type === 'chat:title') {
					if (!isTile) {
						// A tile's title must not clobber the page title; the
						// sidebar list refresh below is still wanted (the
						// primary's handler never sees this pane's event).
						chatTitle.set(data);
					}
					localPaneTitle = String(data ?? '');
					await refreshChatListPageOne(localStorage.token);
				} else if (type === 'chat:tags') {
					chat = await getChatById(localStorage.token, activeChatId);
					allTags.set(await getAllTags(localStorage.token));
				} else if (type === 'source' || type === 'citation') {
					if (message?.sources) {
						message.sources.push(data);
					} else {
						message.sources = [data];
					}
				} else if (type === 'notification') {
					const toastType = data?.type ?? 'info';
					const toastContent = data?.content ?? '';

					if (toastType === 'success') {
						toast.success(toastContent);
					} else if (toastType === 'error') {
						toast.error(toastContent);
					} else if (toastType === 'warning') {
						toast.warning(toastContent);
					} else {
						toast.info(toastContent);
					}
				} else if (type === 'confirmation') {
					eventCallback = cb;
					notifyNativeChatStatus('confirmation', {
						chatId: String(event.chat_id || '').trim(),
						modelId: String(message?.model || '').trim() || null,
						notificationKey: `confirmation:${event.chat_id}:${event.message_id}:${stableNotificationDigest({
							title: data?.title,
							message: data?.message
						})}`
					});

					eventConfirmationInput = false;
					showEventConfirmation = true;

					eventConfirmationTitle = data.title;
					eventConfirmationMessage = data.message;
				} else if (type === 'execute') {
					eventCallback = cb;

					try {
						const result = await runTrustedExecuteAction(
							data && typeof data === 'object' ? data : {}
						);

						if (cb) {
							cb(result);
						}
					} catch (error) {
						console.error('Error executing code:', error);
						toast.error('Blocked unsupported execute request.');
						if (cb) {
							cb({
								success: false,
								error: error instanceof Error ? error.message : 'Unsupported execute action'
							});
						}
					}
				} else if (type === 'input') {
					eventCallback = cb;
					notifyNativeChatStatus('input', {
						chatId: String(event.chat_id || '').trim(),
						modelId: String(message?.model || '').trim() || null,
						notificationKey: `input:${event.chat_id}:${event.message_id}:${stableNotificationDigest({
							title: data?.title,
							message: data?.message,
							placeholder: data?.placeholder
						})}`
					});

					eventConfirmationInput = true;
					showEventConfirmation = true;

					eventConfirmationTitle = data.title;
					eventConfirmationMessage = data.message;
					eventConfirmationInputPlaceholder = data.placeholder;
					eventConfirmationInputValue = data?.value ?? '';
				} else {
					console.log('Unknown message type', data);
				}

				if (shouldAssignMessage) {
					history.messages[event.message_id] = message;
				}
			}
		}
	};

	const onMessageHandler = async (event: {
		origin: string;
		data: { type: string; text: string };
	}) => {
		if (event.origin !== window.origin) {
			return;
		}

		if (event.data.type === 'action:submit') {
			console.debug(event.data.text);

			if (prompt !== '') {
				await tick();
				submitPrompt(consumeReviewerWorkflowArming(prompt));
			}
		}

		// Replace with your iframe's origin
		if (event.data.type === 'input:prompt') {
			console.debug(event.data.text);

			const inputElement = document.getElementById('chat-input');

			if (inputElement) {
				messageInput?.setText(event.data.text);
				inputElement.focus();
			}
		}

		if (event.data.type === 'input:prompt:submit') {
			console.debug(event.data.text);

			if (event.data.text !== '') {
				await tick();
				submitPrompt(consumeReviewerWorkflowArming(event.data.text));
			}
		}
	};

	const savedModelIds = async () => {
		if (
			$selectedFolder &&
			selectedModels.filter((modelId) => modelId !== '').length > 0 &&
			JSON.stringify($selectedFolder?.data?.model_ids) !== JSON.stringify(selectedModels)
		) {
			const res = await updateFolderById(localStorage.token, $selectedFolder.id, {
				data: {
					model_ids: selectedModels
				}
			});
		}
	};

	$: if (selectedModels !== null) {
		savedModelIds();
	}

	let pageSubscribe = null;
	let showControlsSubscribe = null;
	let selectedFolderSubscribe = null;
	let boundChatSocket: any = null;

	const clearDetachedSubagentReconcileTimer = () => {
		if (detachedSubagentReconcileTimer !== null) {
			clearTimeout(detachedSubagentReconcileTimer);
			detachedSubagentReconcileTimer = null;
		}
	};

	const stopDetachedSubagentReconciler = () => {
		clearDetachedSubagentReconcileTimer();
		detachedSubagentReconcileAbortController?.abort();
		detachedSubagentReconcileAbortController = null;
		detachedSubagentReconcileChatId = '';
		detachedSubagentReconcileGeneration = 0;
		detachedSubagentReconcileStartedAt = 0;
		detachedSubagentLastLiveEventAt = 0;
		detachedSubagentTerminalReconcilePending = false;
		// Detaching the old promise lets a new route start immediately; the abort
		// plus generation guards ensure its response cannot reach the next chat.
		detachedSubagentReconcilePromise = null;
	};

	const detachedSubagentReconcilerIsCurrent = (
		targetChatId: string,
		generation: number
	): boolean =>
		delegatedSubagentView &&
		targetChatId === detachedSubagentReconcileChatId &&
		generation === detachedSubagentReconcileGeneration &&
		isCurrentChatLoad(generation, targetChatId) &&
		get(chatId) === targetChatId;

	const scheduleDetachedSubagentReconcile = (delayMs = DETACHED_SUBAGENT_RECONCILE_INTERVAL_MS) => {
		clearDetachedSubagentReconcileTimer();
		if (!detachedSubagentReconcileChatId || document.hidden) return;
		if (
			Date.now() - detachedSubagentReconcileStartedAt >=
			DETACHED_SUBAGENT_RECONCILE_BUDGET_MS
		) {
			stopDetachedSubagentReconciler();
			return;
		}

		detachedSubagentReconcileTimer = setTimeout(() => {
			detachedSubagentReconcileTimer = null;
			const sinceLiveEvent = Date.now() - detachedSubagentLastLiveEventAt;
			if (
				detachedSubagentLastLiveEventAt > 0 &&
				sinceLiveEvent < DETACHED_SUBAGENT_RECONCILE_INTERVAL_MS
			) {
				scheduleDetachedSubagentReconcile(
					DETACHED_SUBAGENT_RECONCILE_INTERVAL_MS - sinceLiveEvent
				);
				return;
			}
			void reconcileDetachedSubagentSnapshot('fallback');
		}, Math.max(0, delayMs));
	};

	const noteDetachedSubagentLiveEvent = (eventType: string | null) => {
		if (!detachedSubagentReconcileChatId) return;
		detachedSubagentLastLiveEventAt = Date.now();
		if (
			eventType === 'chat:completion' ||
			eventType === 'chat:tasks:cancel' ||
			eventType === 'chat:message:error'
		) {
			// Terminal delivery can race the final database update. Reconcile now;
			// the in-flight guard coalesces duplicates and the normal event handler
			// remains responsible for applying the live envelope itself.
			clearDetachedSubagentReconcileTimer();
			detachedSubagentTerminalReconcilePending = true;
			void reconcileDetachedSubagentSnapshot('live_terminal');
			return;
		}
		// Live delivery is primary. Move the persisted-state safety poll out by
		// one interval, while keeping it armed for the next missed event.
		scheduleDetachedSubagentReconcile();
	};

	const applyDetachedSubagentSnapshot = async (
		snapshot: Record<string, any>,
		targetChatId: string,
		generation: number
	) => {
		if (!detachedSubagentReconcilerIsCurrent(targetChatId, generation)) return false;
		const payload = extractDetachedSubagentPayload(snapshot);
		const merged = mergeDetachedSubagentHistory(history, snapshot);
		// Adapt the service-owned child snapshot into the same message state a
		// regular Chat generation creates. Rendering below this boundary remains
		// the ordinary Messages -> ResponseMessage -> ActivityIndicator path.
		const activeHistory = normalizeDetachedSubagentActiveHistory(merged.history);
		let changed = merged.changed || activeHistory.changed;
		if (changed) {
			history = activeHistory.history;
			invalidateSubagentDescendantCache(targetChatId);
		}

		if (payload && Array.isArray(payload.files)) {
			const nextFiles = mergeDetachedSubagentCollection(chatFiles, payload.files, 'files');
			if (JSON.stringify(nextFiles) !== JSON.stringify(chatFiles)) {
				chatFiles = nextFiles;
				changed = true;
			}
		}
		if (payload && typeof payload.title === 'string' && payload.title.trim()) {
			if (payload.title !== $chatTitle) {
				if (!isTile) {
					chatTitle.set(payload.title);
				}
				localPaneTitle = payload.title;
				changed = true;
			}
		}

		if (changed) {
			seedStreamWatchdogForActiveMessages(Date.now());
			bumpContextTokensVersion();
			await tick();
			if (!detachedSubagentReconcilerIsCurrent(targetChatId, generation)) return false;
			if (autoScroll) scrollToBottom();
			scheduleAggregateWorkflowCostRefresh();
			scheduleContextTurnSummaryRefresh();
		}

		if (isDetachedSubagentHistoryTerminal(history)) {
			setTaskIds(null);
			generating = false;
			stopStreamWatchdog();
			stopDetachedSubagentReconciler();
			return true;
		}
		return false;
	};

	const reconcileDetachedSubagentSnapshot = async (
		reason:
			| 'hydrate'
			| 'fallback'
			| 'visibility'
			| 'focus'
			| 'socket_reconnect'
			| 'live_terminal'
	) => {
		const targetChatId = detachedSubagentReconcileChatId;
		const generation = detachedSubagentReconcileGeneration;
		if (!targetChatId || !detachedSubagentReconcilerIsCurrent(targetChatId, generation)) return;
		if (document.hidden && reason === 'fallback') return;
		if (
			Date.now() - detachedSubagentReconcileStartedAt >=
			DETACHED_SUBAGENT_RECONCILE_BUDGET_MS
		) {
			stopDetachedSubagentReconciler();
			return;
		}
		if (detachedSubagentReconcilePromise) {
			const inFlightPromise = detachedSubagentReconcilePromise;
			await inFlightPromise;
			if (detachedSubagentReconcilePromise === inFlightPromise) {
				detachedSubagentReconcilePromise = null;
			}
			if (
				reason === 'live_terminal' &&
				detachedSubagentTerminalReconcilePending &&
				detachedSubagentReconcilerIsCurrent(targetChatId, generation)
			) {
				return reconcileDetachedSubagentSnapshot('live_terminal');
			}
			return;
		}
		if (reason === 'live_terminal') {
			detachedSubagentTerminalReconcilePending = false;
		}

		const abortController = new AbortController();
		detachedSubagentReconcileAbortController = abortController;
		const requestPromise = (async () => {
			try {
				const [snapshot, taskSnapshot] = await Promise.all([
					getChatReconciliationById(
						localStorage.token,
						targetChatId,
						abortController.signal
					),
					getTaskIdsByChatId(localStorage.token, targetChatId).catch(() => null)
				]);
				if (!detachedSubagentReconcilerIsCurrent(targetChatId, generation) || !snapshot) {
					return;
				}
				if (Array.isArray(taskSnapshot?.task_ids)) {
					setTaskIds(taskSnapshot.task_ids);
				}
				const terminal = await applyDetachedSubagentSnapshot(
					snapshot,
					targetChatId,
					generation
				);
				if (!terminal && detachedSubagentReconcilerIsCurrent(targetChatId, generation)) {
					scheduleDetachedSubagentReconcile();
				}
			} catch (error) {
				if (abortController.signal.aborted) return;
				if (detachedSubagentReconcilerIsCurrent(targetChatId, generation)) {
					console.warn(
						`[Chat] Detached subagent ${reason} reconciliation failed; retrying:`,
						error
					);
					scheduleDetachedSubagentReconcile();
				}
			}
		})();
		detachedSubagentReconcilePromise = requestPromise;
		try {
			await requestPromise;
		} finally {
			if (detachedSubagentReconcileAbortController === abortController) {
				detachedSubagentReconcileAbortController = null;
			}
			if (detachedSubagentReconcilePromise === requestPromise) {
				detachedSubagentReconcilePromise = null;
			}
		}
	};

	const startDetachedSubagentReconciler = (targetChatId: string, generation: number) => {
		stopDetachedSubagentReconciler();
		if (!delegatedSubagentView || !targetChatId) return;
		detachedSubagentReconcileChatId = targetChatId;
		detachedSubagentReconcileGeneration = generation;
		detachedSubagentReconcileStartedAt = Date.now();
		detachedSubagentLastLiveEventAt = 0;
		if (isDetachedSubagentHistoryTerminal(history)) {
			setTaskIds(null);
			generating = false;
			stopStreamWatchdog();
			stopDetachedSubagentReconciler();
			return;
		}
		// Do not wait for an assistant placeholder; user-only hydration is the
		// race this fallback is specifically responsible for closing.
		void reconcileDetachedSubagentSnapshot('hydrate');
	};

	const handleDetachedSubagentVisibilityChange = () => {
		if (!detachedSubagentReconcileChatId) return;
		if (document.hidden) {
			clearDetachedSubagentReconcileTimer();
			return;
		}
		void reconcileDetachedSubagentSnapshot('visibility');
	};

	const handleDetachedSubagentWindowFocus = () => {
		if (detachedSubagentReconcileChatId && !document.hidden) {
			void reconcileDetachedSubagentSnapshot('focus');
		}
	};

	// Portico: Socket reconnection resync handler
	// When Socket.IO reconnects, check for messages stuck with done=false
	// and refetch the chat from the backend to get the correct state.
	const socketReconnectHandler = async () => {
		if (!activeChatId || !history?.messages) return;
		if (detachedSubagentReconcileChatId) {
			await reconcileDetachedSubagentSnapshot('socket_reconnect');
		}
		await refreshPendingWork(activeChatId);

		const stuckMessages = Object.values(history.messages).filter(
			(msg: any) => isAssistantMessageActive(msg)
		);

		if (stuckMessages.length === 0) return;

		console.log(
			'[Chat] Socket reconnected, found',
			stuckMessages.length,
			'active assistant messages. Resyncing from backend...'
		);

		try {
			await resyncRunningAssistantMessages();
			await refreshPendingWork(activeChatId);
		} catch (error) {
			console.error('[Chat] Failed to resync after socket reconnect:', error);
		}
	};

	const bindChatSocket = (nextSocket: any) => {
		boundChatSocket = rebindSocketListeners(boundChatSocket, nextSocket, [
			['events', chatEventHandler],
			['connect', socketReconnectHandler]
		]);
	};

	$: bindChatSocket($socket);

	const stopAudio = () => {
		try {
			speechSynthesis.cancel();
			$audioQueue.stop();
		} catch {}
	};

	const handleCostReportUpdated = (event: Event) => {
		const currentChatId = normalizeChatIdValue(activeChatId);
		const changedChatId = normalizeChatIdValue(
			(event as CustomEvent)?.detail?.event?.chatId ??
				(event as CustomEvent)?.detail?.event?.chat_id ??
				(event as CustomEvent)?.detail?.chatId ??
				(event as CustomEvent)?.detail?.chat_id
		);
		const cachedDescendants = currentChatId
			? subagentDescendantCache.get(currentChatId)?.chatIds ?? []
			: [];
		if (
			currentChatId &&
			(!changedChatId || changedChatId === currentChatId || cachedDescendants.includes(changedChatId))
		) {
			invalidateSubagentDescendantCache(currentChatId);
		}
		scheduleAggregateWorkflowCostRefresh();
		scheduleContextTurnSummaryRefresh();
	};

	onMount(async () => {
		streamPerfLoggingEnabled = resolveStreamPerfLoggingEnabled();
		if (streamPerfLoggingEnabled) {
			console.info(
				`[StreamPerf] Enabled (set localStorage.${STREAM_PERF_LOGGING_STORAGE_KEY}=false to disable)`
			);
		}

		if (!chatIdProp) {
			resetReasoningEffortState({ ready: true });
			fastModeEnabled = false;
			fastModePersistedValue = null;
			reviewerWorkflowEnabledLocal = false;
			reviewerWorkflowLocked = false;
		}

		if (!isTile) {
			void readReviewerCtaImpressions(getWebviewHostApi()).then((impressions) => {
				reviewerCtaImpressionsOk = impressions < REVIEWER_WORKFLOW_CTA_MAX_IMPRESSIONS;
				reviewerCtaRemaining = Math.max(
					0,
					REVIEWER_WORKFLOW_CTA_MAX_IMPRESSIONS - impressions - 1
				);
			});
		}

		loading = true;
		console.log('mounted');
		// Cost reports are the one window event every pane instance needs: each
		// handler refreshes only its OWN chat's cost/turn summaries (instance-
		// local activeChatId) through the existing debounce — event-driven, no
		// timers, at most 3 extra listeners while tiled.
		window.addEventListener('owui-cost-report-updated', handleCostReportUpdated);
		if (!isTile) {
			// Tiles bind no other window/document-level listeners: the primary
			// instance owns page-scoped concerns (debug mode, visibility,
			// beforeunload) and two bindings would double-fire.
			window.addEventListener('message', onMessageHandler);
			window.addEventListener('owui-debug-mode-changed', handleDebugModeChanged as EventListener);
			window.addEventListener('owui-konami-unlock-changed', handleKonamiUnlockChanged);
			window.addEventListener('owui-models-refresh-requested', handleModelsRefreshRequested);
			document.addEventListener('visibilitychange', handleDetachedSubagentVisibilityChange);
			window.addEventListener('focus', handleDetachedSubagentWindowFocus);
			// Warn user before leaving the page during active generation
			window.addEventListener('beforeunload', beforeUnloadHandler);

			// Tiles render no <audio>; setting the global queue from a tile
			// (and destroying it on tile teardown) would kill the primary's.
			audioQueue.set(new AudioQueue(document.getElementById('audioElement')));
		}

		if (isTile) {
			// Composer write-back channel. An explicit subscribe (not a `$:`
			// reactive) so back-to-back commands can't be coalesced away by a
			// batched reactive re-run. Seed the seq cursor from the store's
			// current value so a command posted before this tile mounted is
			// never replayed into it.
			lastAppliedPaneCommandSeq = get(multiChatPaneCommands)?.seq ?? 0;
			paneCommandsUnsubscribe = multiChatPaneCommands.subscribe((command) => {
				if (
					!command ||
					!shouldApplyPaneCommand(command, {
						chatId: chatIdProp,
						lastAppliedSeq: lastAppliedPaneCommandSeq
					})
				) {
					return;
				}
				lastAppliedPaneCommandSeq = command.seq;
				applyPaneCommand(command);
			});
		}

		if (delegatedSubagentView) {
			showSidebar.set(false);
		}

		try {
			applyDebugModeEnabled(resolveDebugModeEnabled(await getWebviewHostApi()?.getDebugMode?.()));
		} catch (error) {
			console.warn('[Chat] Failed to initialize debug mode state:', error);
			applyDebugModeEnabled(false);
		}

		pageSubscribe = isTile
			? () => {}
			: page.subscribe(async (p) => {
					if (p.url.pathname === '/') {
						await tick();
						initNewChat();
					}

					stopAudio();
				});

		const storageChatInput = isTile
			? null
			: sessionStorage.getItem(`chat-input${chatIdProp ? `-${chatIdProp}` : ''}`);

		if (!chatIdProp) {
			loading = false;
			await tick();
		}

		if (storageChatInput) {
			prompt = '';
			messageInput?.setText('');

			files = [];
			selectedToolIds = [];
			selectedFilterIds = [];
			webSearchEnabled = false;
			imageGenerationEnabled = false;
			codeInterpreterEnabled = false;

			try {
				const input = JSON.parse(storageChatInput);

				applyDraftInput(input);
			} catch (e) {}
		}

		showControlsSubscribe = isTile
			? () => {}
			: showControls.subscribe(async (value) => {
			if (controlPane && !$mobile) {
				try {
					if (value) {
						controlPaneComponent.openPane();
					} else {
						controlPane.collapse();
					}
				} catch (e) {
					// ignore
				}
			}

			if (!value) {
				showCallOverlay.set(false);
				showOverview.set(false);
				showArtifacts.set(false);
				showEmbeds.set(false);
			}
		});

		selectedFolderSubscribe = isTile
			? () => {}
			: selectedFolder.subscribe(async (folder) => {
			if (
				folder?.data?.model_ids &&
				JSON.stringify(selectedModels) !== JSON.stringify(folder.data.model_ids)
			) {
				selectedModels = resolveEnabledSelectedModelIds(folder.data.model_ids, $models ?? [], { fallback: true });

				console.log('Set selectedModels from folder data:', selectedModels);
			}
		});

		if (!isTile) {
			const chatInput = document.getElementById('chat-input');
			chatInput?.focus();
		}
	});

	onDestroy(() => {
		try {
			chatLoadGeneration += 1;
			chatLoadAbortController?.abort();
			chatLoadAbortController = null;
			pageSubscribe();
			showControlsSubscribe();
			selectedFolderSubscribe();
			chatIdUnsubscriber?.();
			window.removeEventListener('owui-cost-report-updated', handleCostReportUpdated);
			if (!isTile) {
				window.removeEventListener('message', onMessageHandler);
				window.removeEventListener(
					'owui-debug-mode-changed',
					handleDebugModeChanged as EventListener
				);
				window.removeEventListener('owui-konami-unlock-changed', handleKonamiUnlockChanged);
				window.removeEventListener('owui-models-refresh-requested', handleModelsRefreshRequested);
				document.removeEventListener('visibilitychange', handleDetachedSubagentVisibilityChange);
				window.removeEventListener('focus', handleDetachedSubagentWindowFocus);
				window.removeEventListener('beforeunload', beforeUnloadHandler);
			}
			bindChatSocket(null);
			stopDetachedSubagentReconciler();
			if (!isTile) {
				// A tile must never destroy the primary's global audio queue.
				$audioQueue?.destroy();
			}
			paneCommandsUnsubscribe?.();
			paneCommandsUnsubscribe = null;
			multiChatPaneRuntime.update((runtime) => {
				if (!chatIdProp || !(chatIdProp in runtime)) return runtime;
				const next = { ...runtime };
				delete next[chatIdProp];
				return next;
			});
			if (contentsRefreshTimer) {
				clearTimeout(contentsRefreshTimer);
				contentsRefreshTimer = null;
			}
			if (pendingChipNotificationTimer !== null) {
				clearTimeout(pendingChipNotificationTimer);
				pendingChipNotificationTimer = null;
			}
			lastPendingChipNotificationSignature.clear();
			clearAggregateCostRefreshTimer();
			clearContextTurnSummaryRefreshTimer();
			closeDebugMonitorSocket();
			clearDebugMonitorState();
			teardownAutoScrollObserver();
			for (const messageId of Object.keys(streamUsageStateByMessageId)) {
				delete streamUsageStateByMessageId[messageId];
			}
			clearAllStreamingMessageCommitStates();
				if (streamPerfLogInterval !== null) {
					clearInterval(streamPerfLogInterval);
					streamPerfLogInterval = null;
				}
				stopStreamWatchdog();
				forceStoppedMessageIds.clear();
			} catch (e) {
				console.error(e);
			}
		});

	// File upload functions

	const uploadGoogleDriveFile = async (fileData) => {
		console.log('Starting uploadGoogleDriveFile with:', {
			id: fileData.id,
			name: fileData.name,
			url: fileData.url,
			headers: {
				Authorization: `Bearer ${token}`
			}
		});

		// Validate input
		if (!fileData?.id || !fileData?.name || !fileData?.url || !fileData?.headers?.Authorization) {
			throw new Error('Invalid file data provided');
		}

		const tempItemId = uuidv4();
		const fileItem = {
			type: 'file',
			file: '',
			id: null,
			url: fileData.url,
			name: fileData.name,
			collection_name: '',
			status: 'uploading',
			error: '',
			itemId: tempItemId,
			size: 0
		};

		try {
			files = [...files, fileItem];
			console.log('Processing web file with URL:', fileData.url);

			// Configure fetch options with proper headers
			const fetchOptions = {
				headers: {
					Authorization: fileData.headers.Authorization,
					Accept: '*/*'
				},
				method: 'GET'
			};

			// Attempt to fetch the file
			console.log('Fetching file content from Google Drive...');
			const fileResponse = await fetch(fileData.url, fetchOptions);

			if (!fileResponse.ok) {
				const errorText = await fileResponse.text();
				throw new Error(`Failed to fetch file (${fileResponse.status}): ${errorText}`);
			}

			// Get content type from response
			const contentType = fileResponse.headers.get('content-type') || 'application/octet-stream';
			console.log('Response received with content-type:', contentType);

			// Convert response to blob
			console.log('Converting response to blob...');
			const fileBlob = await fileResponse.blob();

			if (fileBlob.size === 0) {
				throw new Error('Retrieved file is empty');
			}

			console.log('Blob created:', {
				size: fileBlob.size,
				type: fileBlob.type || contentType
			});

			// Create File object with proper MIME type
			const file = new File([fileBlob], fileData.name, {
				type: fileBlob.type || contentType
			});

			console.log('File object created:', {
				name: file.name,
				size: file.size,
				type: file.type
			});

			if (file.size === 0) {
				throw new Error('Created file is empty');
			}

			// If the file is an audio file, provide the language for STT.
			let metadata = null;
			if (
				(file.type.startsWith('audio/') || file.type.startsWith('video/')) &&
				$settings?.audio?.stt?.language
			) {
				metadata = {
					language: $settings?.audio?.stt?.language
				};
			}

			// Upload file to server
			console.log('Uploading file to server...');
			const uploadedFile = await uploadFile(localStorage.token, file, metadata);

			if (!uploadedFile) {
				throw new Error('Server returned null response for file upload');
			}

			console.log('File uploaded successfully:', uploadedFile);

			// Update file item with upload results
			fileItem.status = 'uploaded';
			fileItem.file = uploadedFile;
			fileItem.id = uploadedFile.id;
			fileItem.size = file.size;
			fileItem.collection_name = uploadedFile?.meta?.collection_name;
			fileItem.url = `${uploadedFile.id}`;

			files = files;
			toast.success($i18n.t('File uploaded successfully'));
		} catch (e) {
			console.error('Error uploading file:', e);
			files = files.filter((f) => f.itemId !== tempItemId);
			toast.error(
				$i18n.t('Error uploading file: {{error}}', {
					error: e.message || 'Unknown error'
				})
			);
		}
	};

	const uploadWeb = async (urls) => {
		if (!Array.isArray(urls)) {
			urls = [urls];
		}

		// Create file items first
		const fileItems = urls.map((url) => ({
			type: 'text',
			name: url,
			collection_name: '',
			status: 'uploading',
			context: 'full',
			url,
			error: ''
		}));

		// Display all items at once
		files = [...files, ...fileItems];

		for (const fileItem of fileItems) {
			try {
				const res = isYoutubeUrl(fileItem.url)
					? await processYoutubeVideo(localStorage.token, fileItem.url)
					: await processWeb(localStorage.token, '', fileItem.url);

				if (res) {
					fileItem.status = 'uploaded';
					fileItem.collection_name = res.collection_name;
					fileItem.file = {
						...res.file,
						...fileItem.file
					};
				}

				files = [...files];
			} catch (e) {
				files = files.filter((f) => f.name !== url);
				toast.error(`${e}`);
			}
		}
	};

	const onUpload = async (event) => {
		const { type, data } = event;

		if (type === 'google-drive') {
			await uploadGoogleDriveFile(data);
		} else if (type === 'web') {
			await uploadWeb(data);
		}
	};

	const scheduleContentsRefresh = () => {
		if (contentsRefreshTimer) {
			clearTimeout(contentsRefreshTimer);
		}

		contentsRefreshTimer = setTimeout(() => {
			contentsRefreshTimer = null;
			getContents();
		}, CONTENTS_REFRESH_DEBOUNCE_MS);
	};

	$: {
		// Multi-chat: inline artifacts are disabled (windowed-only), and a
		// tile writing the GLOBAL artifactContents from its own history would
		// clobber every other pane's. Skip the whole pipeline off-single.
		const shouldRefreshArtifactContents =
			!multiChatActiveLocal && ($showArtifacts || $showEmbeds);

		if (history) {
			if (shouldRefreshArtifactContents) {
				scheduleContentsRefresh();
			} else if (contentsRefreshTimer) {
				clearTimeout(contentsRefreshTimer);
				contentsRefreshTimer = null;
			}
		} else {
			if (contentsRefreshTimer) {
				clearTimeout(contentsRefreshTimer);
				contentsRefreshTimer = null;
			}
			artifactContents.set([]);
		}

		if (!shouldRefreshArtifactContents) {
			artifactContents.set([]);
		}
	}

	const getContents = () => {
		if (multiChatActiveLocal) {
			return;
		}
		const messages = history?.currentId ? createMessagesList(history, history.currentId) : [];
		let contents = [];
		messages.forEach((message) => {
			if (message?.role !== 'user' && message?.content) {
				const {
					codeBlocks: codeBlocks,
					html: htmlContent,
					css: cssContent,
					js: jsContent
				} = getCodeBlockContents(message.content);

				if (htmlContent || cssContent || jsContent) {
					const renderedContent = `
	                        <!DOCTYPE html>
	                        <html lang="en">
	                        <head>
                            <meta charset="UTF-8">
                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
							<${''}style>
								body {
									background-color: white; /* Ensure the iframe has a white background */
								}

								${cssContent}
							</${''}style>
                        </head>
                        <body>
                            ${htmlContent}

							<${''}script>
                            	${jsContent}
							</${''}script>
                        </body>
                        </html>
                    `;
					contents = [...contents, { type: 'iframe', content: renderedContent }];
				} else {
					// Check for SVG content
					for (const block of codeBlocks) {
						if (block.lang === 'svg' || (block.lang === 'xml' && block.code.includes('<svg'))) {
							contents = [...contents, { type: 'svg', content: block.code }];
						}
					}
				}
			}
		});

		artifactContents.set(contents);
	};

	//////////////////////////
	// Web functions
	//////////////////////////

	const initNewChat = async () => {
		if (isTile) {
			// Unreachable (tiles bind no page subscription) — belt and braces:
			// a tile must never reset global new-chat state.
			return;
		}
		console.log('initNewChat');
		// A new chat has no load/first-paint phase to protect — the
		// chatFirstPaintReady gate exists to defer cost/summary refreshes while a
		// loaded chat paints. New chats never run navigateHandler (the first turn
		// only replaceState()s the URL), so without this the cost pill stays $0.00
		// until the chat is reopened.
		chatFirstPaintReady = true;
		urlSelectedModelResolutionFailed = false;
		if ($user?.role !== 'admin') {
			if ($user?.permissions?.chat?.temporary_enforced) {
				await temporaryChatEnabled.set(true);
			}

			if (!$user?.permissions?.chat?.temporary) {
				await temporaryChatEnabled.set(false);
				return;
			}
		}

		if ($settings?.temporaryChatByDefault ?? false) {
			if ($temporaryChatEnabled === false) {
				await temporaryChatEnabled.set(true);
			} else if ($temporaryChatEnabled === null) {
				// if set to null set to false; refer to temp chat toggle click handler
				await temporaryChatEnabled.set(false);
			}
		}

		const availableModels = getEnabledModelIds($models ?? []);

		if ($page.url.searchParams.get('models') || $page.url.searchParams.get('model')) {
			const urlModels = normalizeSelectedModelIds(
				$page.url.searchParams.get('models') ||
				$page.url.searchParams.get('model') ||
				''
			);
			const refreshedModels = await refreshModelsForUrlSelection(urlModels);
			const resolvedUrlModels = resolveEnabledSelectedModelIds(urlModels, refreshedModels);
			console.log('[Chat] URL-selected model resolution', {
				requestedModelIds: urlModels,
				refreshedModelCount: refreshedModels.length,
				resolvedModelIds: resolvedUrlModels,
				presentAfterRefresh: urlModels.map((modelId) =>
					refreshedModels.some((model) => model?.id === modelId)
				)
			});

			if (resolvedUrlModels.length === urlModels.length) {
				selectedModels = resolvedUrlModels;
			} else {
				selectedModels = resolvedUrlModels;
				urlSelectedModelResolutionFailed = true;
				const failureReason = classifyUrlSelectedModelFailure(urlModels[0] ?? '', refreshedModels);
				console.warn('[Chat] URL-selected model unavailable', {
					requestedModelIds: urlModels,
					refreshedModelCount: refreshedModels.length,
					failureReason
				});
				if (urlModels.length === 1) {
					await openModelSelectorSearch(urlModels[0]);
				}
				toast.error(
					$i18n.t(getUrlSelectedModelErrorMessage(failureReason), {
						modelId: urlModels[0] ?? ''
					})
				);
			}
			} else {
				if ($selectedFolder?.data?.model_ids) {
					selectedModels = normalizeSelectedModelIds($selectedFolder?.data?.model_ids);
				} else {
					// A default the user explicitly saved via the picker's "Set as
					// default" action outranks the implicit last-used carry-forward.
					// The carry-forward is still consumed either way so a stale value
					// cannot resurface on a later new chat.
					const sessionSelectedModels = sessionStorage.selectedModels;
					sessionStorage.removeItem('selectedModels');

					if ($settings?.models) {
						selectedModels = normalizeSelectedModelIds($settings?.models);
					} else if (sessionSelectedModels) {
						selectedModels = normalizeSelectedModelIds(JSON.parse(sessionSelectedModels));
					} else if ($config?.default_models) {
						selectedModels = normalizeSelectedModelIds($config?.default_models);
						console.log(selectedModels);
					}
				}

			selectedModels = resolveEnabledSelectedModelIds(selectedModels, $models ?? []);
		}

		if (
			!urlSelectedModelResolutionFailed &&
			(selectedModels.length === 0 || (selectedModels.length === 1 && selectedModels[0] === ''))
		) {
			selectedModels = resolveEnabledSelectedModelIds(selectedModels, $models ?? [], { fallback: true });
		}

		await showControls.set(false);
		await showCallOverlay.set(false);
		await showOverview.set(false);
		await showArtifacts.set(false);

		if ($page.url.pathname.includes('/c/')) {
			window.history.replaceState(history.state, '', `/`);
		}

		autoScroll = true;

		resetInput();
		setActiveChat('');
		await chatTitle.set('New Chat');
		clearActiveCapabilities();

		history = {
			messages: {},
			currentId: null
		};

		chatFiles = [];
		params = {};

		if ($page.url.searchParams.get('youtube')) {
			await uploadWeb(`https://www.youtube.com/watch?v=${$page.url.searchParams.get('youtube')}`);
		}

		if ($page.url.searchParams.get('load-url')) {
			await uploadWeb($page.url.searchParams.get('load-url'));
		}

		if ($page.url.searchParams.get('web-search') === 'true') {
			webSearchEnabled = true;
		}

		if ($page.url.searchParams.get('image-generation') === 'true') {
			imageGenerationEnabled = true;
		}

		if ($page.url.searchParams.get('code-interpreter') === 'true') {
			codeInterpreterEnabled = true;
		}

		if ($page.url.searchParams.get('tools')) {
			selectedToolIds = $page.url.searchParams
				.get('tools')
				?.split(',')
				.map((id) => id.trim())
				.filter((id) => id);
		} else if ($page.url.searchParams.get('tool-ids')) {
			selectedToolIds = $page.url.searchParams
				.get('tool-ids')
				?.split(',')
				.map((id) => id.trim())
				.filter((id) => id);
		}

		if ($page.url.searchParams.get('call') === 'true') {
			showCallOverlay.set(true);
			showControls.set(true);
		}

		if ($page.url.searchParams.get('q')) {
			const q = $page.url.searchParams.get('q') ?? '';
			messageInput?.setText(q);

			if (q) {
				if (($page.url.searchParams.get('submit') ?? 'true') === 'true') {
					await tick();
					submitPrompt(consumeReviewerWorkflowArming(q));
				}
			}
		}

		selectedModels = resolveEnabledSelectedModelIds(selectedModels, $models ?? [], {
			fallback: !urlSelectedModelResolutionFailed
		});
		resetReasoningEffortState({ ready: true });
		fastModeEnabled = false;
		fastModePersistedValue = null;
		reviewerWorkflowEnabledLocal = false;
		reviewerWorkflowLocked = false;

		const chatInput = document.getElementById('chat-input');
		setTimeout(() => chatInput?.focus(), 0);
	};

	// Seed the reasoning effort from the loaded chat's params (index "0") when no
	// explicit per-model entry exists. Used for delegated subagent chats, whose
	// chat-state is service-owned and unreadable by the human — create_subagent_chat
	// stamps params.reasoning_effort so the effort still shows. Never overrides an
	// existing entry.
	const seedReasoningEffortFromChatParams = () => {
		const next = seedReasoningEffortFromParams(reasoningEffortByModel, params);
		if (next !== reasoningEffortByModel) {
			reasoningEffortLedger = primeReasoningEffortLedger({
				ledger: reasoningEffortLedger,
				modelIds: selectedModelIds,
				reasoningEffortByModel: next
			});
			setReasoningEffortState({ nextMap: next, markPersisted: true });
		}
	};

	const loadDeferredChatState = async (targetChatId: string, generation: number) => {
		const token = localStorage.token;
		const [nextTags, taskRes, nextPendingWork, persistedState, capabilities] =
			await Promise.all([
				getTagsById(token, targetChatId).catch(() => []),
				getTaskIdsByChatId(token, targetChatId).catch(() => null),
				getChatPendingWork(token, targetChatId),
				getChatState(targetChatId),
				getChatCapabilities(token, targetChatId)
			]);

		// Instance-local guard: tiles never write the global chatId store, so a
		// global compare would skip deferred hydration (persisted fast mode /
		// reasoning effort / context tokens, initial capabilities, pending work)
		// for every tile. setActiveChat(targetChatId) ran at loadChat start, so
		// equality holds for the current load in all pane roles.
		if (!isCurrentChatLoad(generation, targetChatId) || activeChatId !== targetChatId) {
			return;
		}

		tags = nextTags;
		const taskStateKnown = taskRes !== null;
		if (Array.isArray(taskRes?.task_ids)) {
			setTaskIds(taskRes.task_ids);
		} else {
			setTaskIds(null);
		}
		if (delegatedSubagentView) {
			const activeHistory = normalizeDetachedSubagentActiveHistory(history);
			if (activeHistory.changed) {
				history = activeHistory.history;
			}
		}

		const hasActiveChatTasks = Array.isArray(taskIds) && taskIds.length > 0;
		const { changed: normalizedHistoryChanged, staleNormalizedCount } =
			normalizeHydratedAssistantMessages(history?.messages ?? null, {
				// Delegated chats are service-owned, so the owner-filtered task endpoint
				// cannot prove they are idle. Their message terminal markers are authoritative.
				hasActiveChatTasks: delegatedSubagentView
					? true
					: taskStateKnown
						? hasActiveChatTasks
						: true
			});
		if (taskStateKnown && !hasActiveChatTasks && staleNormalizedCount > 0) {
			console.warn(
				`[Chat] Normalized ${staleNormalizedCount} stale assistant message(s) after task-state hydration`
			);
		}
		if (normalizedHistoryChanged) {
			history = history;
		}

		applyPendingWorkState(nextPendingWork);
		// applyPersistedChatState gap-fills the reasoning effort from the chat
		// record's params afterwards, which covers every chat whose creation
		// persisted a launch effort: delegated subagent chats (chat-state read
		// blocked by service ownership → getChatState returns null) AND
		// workflow-started peer chats (human-owned but no chat-state snapshot
		// exists until the user touches the picker).
		applyPersistedChatState(persistedState as Record<string, any> | null);
		reasoningEffortReady = true;
		applyActiveCapabilities(capabilities, targetChatId);

		if (isCurrentChatLoad(generation, targetChatId)) {
			await resyncRunningAssistantMessages(targetChatId, generation);
		}
		if (
			taskStateKnown &&
			isCurrentChatLoad(generation, targetChatId) &&
			get(chatId) === targetChatId
		) {
			tabActivityChatId = targetChatId;
		}
	};

	const loadChat = async (
		targetChatId: string,
		generation: number,
		signal: AbortSignal
	) => {
		setActiveChat(targetChatId);

		if (!isTile && $temporaryChatEnabled) {
			temporaryChatEnabled.set(false);
		}

		detachedSubagentLoadError = false;
		const nextChat = await getChatHydrationById(localStorage.token, targetChatId, signal);
		if (!isCurrentChatLoad(generation, targetChatId)) {
			return false;
		}
		chat = nextChat;

		const chatContent = chat?.chat;
		if (!chatContent) {
			return false;
		}
		hydratedDelegatedSubagentView = hasDelegatedSubagentMetadata(chatContent);
		const isDelegatedChat =
			isDelegatedSubagentRoute($page.url.searchParams) || hydratedDelegatedSubagentView;

		selectedModels = normalizeSelectedModelIds(
			(chatContent?.models ?? undefined) !== undefined ? chatContent.models : chatContent.model
		);
		if (!($user?.role === 'admin' || ($user?.permissions?.chat?.multiple_models ?? true))) {
			selectedModels = selectedModels.length > 0 ? [selectedModels[0]] : [''];
		}
		oldSelectedModelIds = JSON.parse(JSON.stringify(selectedModels));

		{
			const fetchedHistory =
				(chatContent?.history ?? undefined) !== undefined
					? chatContent.history
					: convertMessagesToHistory(chatContent.messages);
			// Freshly-started chats race their first queued-prompt dispatch against
			// this initial fetch: a background-turn insertion can already be
			// reconciled locally while the (stale, pre-dispatch) snapshot is in
			// flight. Merge remembered insertions the snapshot is missing instead
			// of clobbering them (requirePersistedAssistant=false: the snapshot may
			// predate the whole turn).
			history =
				repairProtectedBackgroundTurnHistoryWithStoredPayloads(fetchedHistory, {
					requirePersistedAssistant: false
				}).history ?? fetchedHistory;
		}
		invalidateSubagentDescendantCache(targetChatId);
		chatTitle.set(chatContent.title);
		params = chatContent?.params ?? {};
		chatFiles = chatContent?.files ?? [];

		// Reviewer workflow: resolve this chat's toggle. Locked once any
		// messages exist; the persisted flag wins, chats that predate the
		// feature read as locked-off. Children of a multi-chat root inherit
		// the ROOT's decision read-only (composer-relevant, so skipped for
		// composer-less tiles).
		const reviewerHasMessages =
			Boolean(chatContent?.history?.currentId) ||
			Object.keys(chatContent?.history?.messages ?? {}).length > 0;
		const reviewerState = resolveReviewerWorkflowChatState({
			chatFlag: chatContent?.reviewer_workflow,
			hasMessages: reviewerHasMessages
		});
		reviewerWorkflowEnabledLocal = reviewerState.enabled;
		reviewerWorkflowLocked = reviewerState.locked;
		const reviewerRootChatId = chat?.meta?.multi_chat?.started_by_chat_id;
		if (
			!isTile &&
			typeof chatContent?.reviewer_workflow !== 'boolean' &&
			typeof reviewerRootChatId === 'string' &&
			reviewerRootChatId
		) {
			reviewerWorkflowLocked = true;
			void getChatById(localStorage.token, reviewerRootChatId)
				.then((rootChat) => {
					if (isCurrentChatLoad(generation, targetChatId)) {
						reviewerWorkflowEnabledLocal = rootChat?.chat?.reviewer_workflow === true;
					}
				})
				.catch(() => {});
		}

		autoScroll = true;
		// Seed the reasoning effort from the chat record's params right here — the
		// reasoning picker renders as soon as selectedModels resolves (above), so
		// waiting for the deferred loadDeferredChatState seed would flash the model
		// default (Low) before flipping to the real effort. reasoningEffortReady is
		// still false, so the reactive normalize won't prune index "0" yet.
		// Applies to any chat record carrying a launch effort — delegated subagent
		// chats AND workflow-started peer chats (start_chat persists
		// params.reasoning_effort); ordinary chats have no such param.
		if (isDelegatedChat || typeof params?.reasoning_effort === 'string') {
			seedReasoningEffortFromChatParams();
		}
		if (isDelegatedChat) {
			const activeHistory = normalizeDetachedSubagentActiveHistory(history);
			if (activeHistory.changed) {
				history = activeHistory.history;
			}
		}

		const { changed: normalizedHistoryChanged } = normalizeHydratedMessagesForFirstPaint(
			history?.messages ?? null
		);
		if (normalizedHistoryChanged) {
			history = history;
		}

		return true;
	};

	const getErrorMessage = (error: any) => {
		if (!error) {
			return '';
		}
		if (typeof error === 'string') {
			return error;
		}
		if (error?.content && typeof error.content === 'string') {
			return error.content;
		}
		if (error?.error?.content && typeof error.error.content === 'string') {
			return error.error.content;
		}
		if (error?.detail) {
			return error.detail;
		}
		if (error?.error?.message) {
			return error.error.message;
		}
		if (error?.error && typeof error.error === 'string') {
			return error.error;
		}
		if (error?.message) {
			return error.message;
		}
		return '';
	};

	const isRateLimitError = (error: any) => {
		if (!error) {
			return false;
		}
		const errorType = error?.error?.type || error?.type;
		const errorCode = error?.error?.code || error?.code || error?.status;
		if (errorType && String(errorType).includes('rate_limit')) {
			return true;
		}
		if (errorCode === 429 || errorCode === 'apptokenratelimit') {
			return true;
		}
		const message = getErrorMessage(error).toLowerCase();
		return message.includes('rate limit') || message.includes('ratelimit');
	};

	const isPorticoGatewayAuthHeaderMissingError = (error: any) => {
		const baseMessage = getErrorMessage(error);
		let serializedError = '';
		try {
			serializedError = JSON.stringify(error ?? {});
		} catch {
			serializedError = '';
		}

		const haystack = `${baseMessage} ${serializedError}`.toLowerCase();
		return (
			haystack.includes('missing_authorization') ||
			haystack.includes('authorization header is missing') ||
			(haystack.includes('bedrockexception') && haystack.includes('authorization'))
		);
	};

	const isModelAccessDeniedError = (error: any) => {
		const errorObj = error?.error ?? error ?? {};
		const statusCode = errorObj?.status ?? errorObj?.statusCode ?? errorObj?.status_code;
		const errorType = (errorObj?.type ?? errorObj?.code ?? '').toLowerCase();
		const baseMessage = getErrorMessage(error).toLowerCase();

		if (statusCode === 403 && (errorType.includes('accessdenied') || baseMessage.includes('accessdeniedexception'))) {
			return true;
		}

		if (baseMessage.includes('accessdeniedexception')) {
			return true;
		}

		if (baseMessage.includes('this model is temporarily not available for your account')) {
			return true;
		}

		return false;
	};

	const getFriendlyErrorMessage = (error: any) => {
		if (isPorticoGatewayAuthHeaderMissingError(error)) {
			return $i18n.t(
				"Oops, there was a problem connecting to Portico's AI Gateway. Please go to the Control Plane tab and click Restart Services and try again once the application restarts."
			);
		}
		if (isModelAccessDeniedError(error)) {
			return $i18n.t(
				'This model is temporarily not available for your account. ' +
				'Please switch to a different model (e.g. Atlas Sonnet 5, Atlas Haiku 4.5, or a GPT model) and retry. ' +
				'This is a known issue — see [CBO-745](https://portico.atlassian.net/browse/CBO-745) for details and updates.'
			);
		}
		if (isRateLimitError(error)) {
			const errorType = error?.error?.type || error?.type;
			if (errorType === 'rate_limit_canceled') {
				return $i18n.t('Rate limit retry canceled.');
			}
			return $i18n.t('We hit a rate limit and stopped retrying.');
		}
		return getErrorMessage(error) || $i18n.t('Uh-oh! There was an issue with the response.');
	};

	const clearRateLimitOverlay = () => {
		rateLimitOverlayActive = false;
		rateLimitOverlayAttempt = 0;
		rateLimitOverlayMaxAttempts = 0;
		rateLimitOverlayRemainingMs = 0;
		rateLimitOverlayPhase = 'waiting';
		rateLimitOverlayMessageId = null;
		rateLimitOverlayCanceling = false;

		if (rateLimitOverlayInterval) {
			clearInterval(rateLimitOverlayInterval);
			rateLimitOverlayInterval = null;
		}
	};

	const startRateLimitCountdown = (delayMs: number) => {
		if (rateLimitOverlayInterval) {
			clearInterval(rateLimitOverlayInterval);
			rateLimitOverlayInterval = null;
		}

		const waitMs = Math.max(0, delayMs || 0);
		if (!waitMs) {
			rateLimitOverlayRemainingMs = 0;
			return;
		}

		const deadline = Date.now() + waitMs;
		const update = () => {
			rateLimitOverlayRemainingMs = Math.max(0, deadline - Date.now());
			if (rateLimitOverlayRemainingMs <= 0 && rateLimitOverlayInterval) {
				clearInterval(rateLimitOverlayInterval);
				rateLimitOverlayInterval = null;
			}
		};

		update();
		rateLimitOverlayInterval = setInterval(update, 250);
	};

	const cancelRateLimitRetry = async () => {
		if (!activeChatId || !rateLimitOverlayMessageId || rateLimitOverlayCanceling) {
			return;
		}

		const resumeMs = rateLimitOverlayRemainingMs;
		rateLimitOverlayCanceling = true;
		rateLimitOverlayPhase = 'canceling';
		rateLimitOverlayRemainingMs = 0;

		if (rateLimitOverlayInterval) {
			clearInterval(rateLimitOverlayInterval);
			rateLimitOverlayInterval = null;
		}

		try {
			const response = await fetch(
				`${WEBUI_BASE_URL}/api/v1/chats/${activeChatId}/messages/${rateLimitOverlayMessageId}/rate-limit/cancel`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${localStorage.token}`
					}
				}
			);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
		} catch (error) {
			console.warn('[RateLimitRetry] Cancel failed:', error);
			rateLimitOverlayCanceling = false;
			rateLimitOverlayPhase = 'waiting';
			startRateLimitCountdown(resumeMs);
			toast.error($i18n.t('Failed to cancel retry.'));
		}
	};

	const handleRateLimitEvent = (payload: any, messageId?: string) => {
		if (!payload) {
			return;
		}

		const phase = payload?.phase ?? 'waiting';
		const attempt =
			typeof payload?.attempt === 'number' ? payload.attempt : rateLimitOverlayAttempt;
		const maxAttempts =
			typeof payload?.max_attempts === 'number'
				? payload.max_attempts
				: rateLimitOverlayMaxAttempts;

		rateLimitOverlayAttempt = attempt;
		rateLimitOverlayMaxAttempts = maxAttempts;
		rateLimitOverlayMessageId = messageId ?? rateLimitOverlayMessageId;
		rateLimitOverlayCanceling = false;

		if (phase === 'waiting') {
			rateLimitOverlayActive = true;
			rateLimitOverlayPhase = 'waiting';
			const waitMs = payload?.wait_ms ?? payload?.retry_after_ms ?? 0;
			startRateLimitCountdown(waitMs);
			return;
		}

		if (phase === 'retrying') {
			rateLimitOverlayActive = true;
			rateLimitOverlayPhase = 'retrying';
			rateLimitOverlayRemainingMs = 0;
			if (rateLimitOverlayInterval) {
				clearInterval(rateLimitOverlayInterval);
				rateLimitOverlayInterval = null;
			}
			return;
		}

		if (['succeeded', 'resolved', 'cleared', 'failed', 'canceled'].includes(phase)) {
			clearRateLimitOverlay();
		}
	};

	const scrollToBottom = async (behavior = 'auto') => {
		autoScroll = true;
		await tick();
		scrollMessagesContainerToBottom(behavior);
	};

	const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 50;
	const AUTO_SCROLL_PROGRAMMATIC_GUARD_MS = 200;
	const isDocumentHidden = () =>
		typeof document !== 'undefined' && document.visibilityState === 'hidden';
	const markAutoScrollProgrammaticWrite = () => {
		autoScrollProgrammaticGuardUntil = Date.now() + AUTO_SCROLL_PROGRAMMATIC_GUARD_MS;
	};
	const hasActiveProgrammaticScrollWrite = () =>
		Date.now() < autoScrollProgrammaticGuardUntil;
	const scrollMessagesContainerToBottom = (behavior: ScrollBehavior = 'auto') => {
		if (!messagesContainerElement) return;
		markAutoScrollProgrammaticWrite();
		messagesContainerElement.scrollTo({
			top: messagesContainerElement.scrollHeight,
			behavior
		});
	};

	// PORTICO_PATCH: Sticky auto-scroll.
	//
	// Use a post-layout ResizeObserver for bottom sticking, but do not keep a
	// 50ms force-scroll loop alive during streaming. Programmatic writes are
	// guarded so manual user scroll intent can detach auto-scroll naturally.

	const setupAutoScrollObserver = () => {
		if (autoScrollObserver || !messagesContentElement || !messagesContainerElement) return;
		autoScrollObserver = new ResizeObserver(() => {
			if (autoScroll && messagesContainerElement) {
				scrollMessagesContainerToBottom('auto');
			}
		});
		autoScrollObserver.observe(messagesContentElement);
	};

	$: if (messagesContentElement && messagesContainerElement) {
		setupAutoScrollObserver();
	}

	const startAutoScrollPolling = () => {
		return;
	};

	const stopAutoScrollPolling = () => {
		if (autoScrollInterval) {
			clearInterval(autoScrollInterval);
			autoScrollInterval = null;
		}
		// Final scroll after stopping — catches content that arrived
		// in the same tick as generating=false (e.g. thinking models
		// that dump all visible text right before stream end).
		if (autoScroll && messagesContainerElement) {
			setTimeout(() => {
				if (autoScroll && messagesContainerElement) {
					scrollMessagesContainerToBottom('auto');
				}
			}, 100);
		}
	};

	// Start/stop polling when streaming starts/stops.
	$: if (generating) {
		startAutoScrollPolling();
	} else {
		stopAutoScrollPolling();
	}

	// PORTICO PATCH (N-012): retry the auto-fire batch-send when ``generating``
	// transitions to ``false``. Without this watcher, a chip approved while
	// the assistant is still streaming gets parked in 'approved' state but
	// the batch-send never fires (handleToolConfirmationChipDecision short-
	// circuits when generating is true), leaving the chip orphaned on screen
	// and the backend approval unfulfilled until the next user turn. We only
	// re-trigger when:
	//   * generating just flipped false (we're idle now),
	//   * a non-empty list of chips exists (something to drain),
	//   * every chip is in a terminal state (user finished deciding),
	//   * no batch is already inflight (race protection).
	$: if (
		!generating &&
		pendingToolConfirmations.length > 0 &&
		!toolConfirmationBatchInFlight &&
		pendingToolConfirmations.every((chip) => chip.state !== 'pending')
	) {
		toolConfirmationBatchInFlight = true;
		fireToolConfirmationBatchSend();
	}

	const teardownAutoScrollObserver = () => {
		autoScrollObserver?.disconnect();
		autoScrollObserver = null;
		stopAutoScrollPolling();
	};

	const handleMessagesWheel = (event: WheelEvent) => {
		if (event.deltaY < -2 && autoScroll && !hasActiveProgrammaticScrollWrite()) {
			autoScroll = false;
		}
	};

	const handleMessagesScroll = () => {
		if (!messagesContainerElement) return;
		const { scrollHeight, scrollTop, clientHeight } = messagesContainerElement;
		const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
		const isNearBottom = distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;

		if (generating) {
			if (isNearBottom) {
				autoScroll = true;
			} else if (!hasActiveProgrammaticScrollWrite()) {
				autoScroll = false;
			}
		} else {
			autoScroll = isNearBottom;
		}
	};

	const clearGenerationStateIfIdle = (options: { clearTaskIds?: boolean } = {}) => {
		const hasPendingAssistantMessage = Object.values(history?.messages ?? {}).some(
			(msg: any) => isAssistantMessageActive(msg)
		);

		if (!hasPendingAssistantMessage) {
			if (options.clearTaskIds !== false) {
				setTaskIds(null);
			}
			generating = false;
			generationController?.abort();
			generationController = null;
			clearRateLimitOverlay();
			stopStreamWatchdog();
			// PORTICO PATCH (N-012): the batch-send chat turn has settled.
			// Allow the next chip-decision auto-fire scheduler to run again.
			toolConfirmationBatchInFlight = false;
		}
	};

	const finalizeAssistantErrorMessage = async (
		error: any,
		responseMessage: Record<string, any>,
		options: { toast?: boolean; scroll?: boolean; stopReason?: string | null } = {}
	) => {
		const errorMessage = getFriendlyErrorMessage(error);
		console.error(error);

		if (isModelAccessDeniedError(error)) {
			responseMessage.content = errorMessage;
		} else {
			if (options.toast !== false) {
				toast.error(errorMessage);
			}
			responseMessage.error = {
				content: errorMessage
			};
		}

		applyLocalStopToAssistantMessage(
			responseMessage,
			resolveAssistantStopReason(
				responseMessage,
				options.stopReason ?? TERMINAL_ERROR_STOP_REASON
			) ?? TERMINAL_ERROR_STOP_REASON
		);
		clearStreamingProgressState(responseMessage.id);
		clearStreamingMessageCommitState(responseMessage.id);
		delete streamUsageStateByMessageId[responseMessage.id];

		if (responseMessage.statusHistory) {
			responseMessage.statusHistory = responseMessage.statusHistory.filter(
				(status) =>
					status.action !== 'knowledge_search' &&
					status.action !== STREAM_PROGRESS_STATUS_ACTION
			);
		}

		history.messages[responseMessage.id] = responseMessage;
		history = history;
		clearRateLimitOverlay();
		clearGenerationStateIfIdle();

		// PORTICO PATCH (N-012): drop pending tool-confirmation chips when the
		// assistant turn that produced them errored out. Chips are tied to a
		// specific assistant turn — if that turn died (network error, model
		// 5xx, terminal stream error, etc.), the chips can no longer be
		// resolved cleanly. Mirroring the user-stop cleanup keeps the
		// frontend in sync with what the user actually sees in the chat.
		pendingToolConfirmations = [];
		toolConfirmationBatchInFlight = false;

		if (options.scroll !== false) {
			autoScroll = true;
			await tick();
			scrollToBottom();
		}
	};

	const handleChatRequestError = async (error, responseMessage, responseMessageId) => {
		responseMessage.id = responseMessageId;
		await finalizeAssistantErrorMessage(error, responseMessage, {
			toast: true,
			scroll: true,
			stopReason: TERMINAL_ERROR_STOP_REASON
		});
		history.currentId = responseMessageId;
	};
	const chatCompletedHandler = async (_chatId, modelId, responseMessageId, messages) => {
		// Delegated subagent views are read-only projections of a service-owned
		// child chat, whether detached or redocked. Replaying /chat/completed here
		// can run outlet/tool-loop callbacks a second time, and updateChatById is
		// not authorized for the human viewer. Live events and persisted reconciliation already apply
		// the terminal message locally, so completion side effects must stay with
		// the service-owned generation request.
		if (delegatedSubagentView) {
			clearGenerationStateIfIdle();
			return;
		}

		const res = await chatCompleted(localStorage.token, {
			model: modelId,
			messages: messages.map((m) => ({
				id: m.id,
				role: m.role,
				content: m.content,
				...(m.contentBlocks && { contentBlocks: m.contentBlocks }), // Preserve contentBlocks for Phoenix observability
				info: m.info ? m.info : undefined,
				timestamp: m.timestamp,
				...(m.usage ? { usage: m.usage } : {}),
				...(m.sources ? { sources: m.sources } : {})
			})),
			filter_ids: selectedFilterIds.length > 0 ? selectedFilterIds : undefined,
			model_item: $models.find((m) => m.id === modelId),
			chat_id: _chatId,
			session_id: $socket?.id,
			id: responseMessageId
		}).catch((error) => {
			toast.error(`${error}`);
			messages.at(-1).error = { content: error };

			return null;
		});
		// Completion persistence can outlive a rapid route change. Never merge
		// the completed chat's response into whichever history is visible now.
		if (get(chatId) !== _chatId) {
			return;
		}

		if (res !== null && res.messages) {
			// Update chat history with the new messages
			for (const message of res.messages) {
				if (message?.id) {
					// Add null check for message and message.id
					const existingMessage = history.messages[message.id] ?? {};
					const mergedUsage = mergePromptUsage(
						(existingMessage?.usage ?? undefined) as Record<string, unknown> | undefined,
						(message?.usage ?? undefined) as Record<string, unknown> | undefined,
						'max'
					);
					history.messages[message.id] = {
						...existingMessage,
						...(existingMessage.content !== message.content
							? { originalContent: existingMessage.content }
							: {}),
						...message,
						usage: mergedUsage
					};
				}
			}
			bumpContextTokensVersion();
		}

		await tick();
		if (get(chatId) !== _chatId) {
			return;
		}

		if (!$temporaryChatEnabled) {
			const updatedChat = await updateChatById(localStorage.token, _chatId, {
					models: selectedModels,
					messages: messages,
					history: history,
					params: params,
					files: chatFiles
				});
			if (get(chatId) !== _chatId) {
				return;
			}
			chat = updatedChat;

			await refreshChatListPageOne(localStorage.token);
		}

		if (get(chatId) !== _chatId) {
			return;
		}
		clearGenerationStateIfIdle();
	};

	const chatActionHandler = async (_chatId, actionId, modelId, responseMessageId, event = null) => {
		if (delegatedSubagentView) return null;
		const messages = createMessagesList(history, responseMessageId);

		const res = await chatAction(localStorage.token, actionId, {
			model: modelId,
			messages: messages.map((m) => ({
				id: m.id,
				role: m.role,
				content: m.content,
				...(m.contentBlocks && { contentBlocks: m.contentBlocks }), // Preserve contentBlocks for Phoenix observability
				info: m.info ? m.info : undefined,
				timestamp: m.timestamp,
				...(m.sources ? { sources: m.sources } : {})
			})),
			...(event ? { event: event } : {}),
			model_item: $models.find((m) => m.id === modelId),
			chat_id: _chatId,
			session_id: $socket?.id,
			id: responseMessageId
		}).catch((error) => {
			toast.error(`${error}`);
			messages.at(-1).error = { content: error };
			return null;
		});

		if (res !== null && res.messages) {
			// Update chat history with the new messages
			for (const message of res.messages) {
				history.messages[message.id] = {
					...history.messages[message.id],
					...(history.messages[message.id].content !== message.content
						? { originalContent: history.messages[message.id].content }
						: {}),
					...message
				};
			}
			bumpContextTokensVersion();
		}

		if (activeChatId == _chatId) {
			if (!$temporaryChatEnabled) {
				chat = await updateChatById(localStorage.token, _chatId, {
					models: selectedModels,
					messages: messages,
					history: history,
					params: params,
					files: chatFiles
				});

				await refreshChatListPageOne(localStorage.token);
			}
		}
	};

	const getChatEventEmitter = async (modelId: string, chatId: string = '') => {
		return setInterval(() => {
			$socket?.emit('usage', {
				action: 'chat',
				model: modelId,
				chat_id: chatId
			});
		}, 1000);
	};

	const createMessagePair = async (userPrompt) => {
		messageInput?.setText('');
		if (selectedModels.length === 0) {
			toast.error($i18n.t('Model not selected'));
		} else {
			const modelId = selectedModels[0];
			const model = $models.filter((m) => m.id === modelId).at(0);

			const messages = createMessagesList(history, history.currentId);
			const parentMessage = messages.length !== 0 ? messages.at(-1) : null;

			const userMessageId = uuidv4();
			const responseMessageId = uuidv4();

			const userMessage = {
				id: userMessageId,
				parentId: parentMessage ? parentMessage.id : null,
				childrenIds: [responseMessageId],
				role: 'user',
				content: userPrompt ? userPrompt : `[PROMPT] ${userMessageId}`,
				timestamp: Math.floor(Date.now() / 1000)
			};

			const responseMessage = {
				id: responseMessageId,
				parentId: userMessageId,
				childrenIds: [],
				role: 'assistant',
				content: `[RESPONSE] ${responseMessageId}`,
				done: true,

				model: modelId,
				modelName: model.name ?? model.id,
				modelIdx: 0,
				timestamp: Math.floor(Date.now() / 1000)
			};

			if (parentMessage) {
				parentMessage.childrenIds.push(userMessageId);
				history.messages[parentMessage.id] = parentMessage;
			}
			history.messages[userMessageId] = userMessage;
			history.messages[responseMessageId] = responseMessage;

			history.currentId = responseMessageId;

			await tick();

			if (autoScroll) {
				scrollToBottom();
			}

			if (messages.length === 0) {
				await initChatHandler(history);
			} else {
				await saveChatHandler(activeChatId, history);
			}
		}
	};

	const addMessages = async ({ modelId, parentId, messages }) => {
		const model = $models.filter((m) => m.id === modelId).at(0);

		let parentMessage = history.messages[parentId];
		let currentParentId = parentMessage ? parentMessage.id : null;
		for (const message of messages) {
			let messageId = uuidv4();

			if (message.role === 'user') {
				const userMessage = {
					id: messageId,
					parentId: currentParentId,
					childrenIds: [],
					timestamp: Math.floor(Date.now() / 1000),
					...message
				};

				if (parentMessage) {
					parentMessage.childrenIds.push(messageId);
					history.messages[parentMessage.id] = parentMessage;
				}

				history.messages[messageId] = userMessage;
				parentMessage = userMessage;
				currentParentId = messageId;
			} else {
				const responseMessage = {
					id: messageId,
					parentId: currentParentId,
					childrenIds: [],
					done: true,
					model: model.id,
					modelName: model.name ?? model.id,
					modelIdx: 0,
					timestamp: Math.floor(Date.now() / 1000),
					...message
				};

				if (parentMessage) {
					parentMessage.childrenIds.push(messageId);
					history.messages[parentMessage.id] = parentMessage;
				}

				history.messages[messageId] = responseMessage;
				parentMessage = responseMessage;
				currentParentId = messageId;
			}
		}

		history.currentId = currentParentId;
		await tick();

		if (autoScroll) {
			scrollToBottom();
		}

		if (messages.length === 0) {
			await initChatHandler(history);
		} else {
			await saveChatHandler(activeChatId, history);
		}
	};

		const chatCompletionEventHandler = async (data, message, chatId) => {
			if (message?.id && forceStoppedMessageIds.has(message.id)) {
				if (DEBUG_CHAT_EVENTS) {
					console.debug('[ChatCompletion] Ignoring completion update for force-stopped message', {
						messageId: message.id
					});
				}
				return;
			}

			const {
				id,
				done,
				choices,
				content,
				contentBlocks,
				tool_calls,
				sources,
				files,
				selected_model_id,
				error,
				usage
			} =
				data;
		const shouldProcessStreamingTTS =
			($settings?.conversationMode ?? false) || ($settings?.responseAutoPlayback ?? false);
		let messageUpdated = false;
		let committedMessageUpdate = false;

		// PORTICO_PATCH: Set the done flag EARLY — before content processing —
		// so the content guards (isStaleStreamingContentRegression and
		// isNonMonotonicStreamingReplacement) accept the authoritative final
		// payload.  Both guards skip when message.done === true.
		//
		// Without this, the final content (which has e.g. reasoning block
		// done="true" replacing done="false") gets rejected as a
		// "non-monotonic replacement" because the text differs in the middle,
		// not at the end.  This left the Collapsible timer running forever.
		if (done && !message.done) {
			message.done = true;
			messageUpdated = true;
		}

		const commitMessageUpdate = () => {
			if (!messageUpdated) return;
			if (done) {
				committedMessageUpdate = flushPendingStreamingMessageCommit(message);
			} else {
				committedMessageUpdate = scheduleStreamingMessageCommit(message);
			}
			messageUpdated = false;
		};

		if (error) {
			await handleOpenAIError(error, message);
			return;
		}

		if (sources && !message?.sources) {
			message.sources = sources;
			messageUpdated = true;
		}

		if (choices) {
			if (choices[0]?.message?.content) {
				// Non-stream response
				const deltaText = stripFrameworkCommentArtifacts(choices[0]?.message?.content ?? '');
				if (deltaText) {
					message.content += deltaText;
					recordStreamingContentSnapshot(message?.id, message?.content);
					noteVisibleAssistantProgress(message);
					messageUpdated = true;
				}
			} else {
				// Stream response
				const value = stripFrameworkCommentArtifacts(choices[0]?.delta?.content ?? '');
				if (message.content == '' && value == '\n') {
					console.log('Empty response');
				} else {
					if (value) {
						message.content += value;
						recordStreamingContentSnapshot(message?.id, message?.content);
						markStreamingDeltaChunk(message?.id);
						noteVisibleAssistantProgress(message);
						messageUpdated = true;
					}

					if (navigator.vibrate && ($settings?.hapticFeedback ?? false)) {
						navigator.vibrate(5);
					}

					if (shouldProcessStreamingTTS) {
						// Emit chat event for TTS only when streaming speech features are enabled.
						const messageContentParts = getMessageContentParts(
							removeAllDetails(message.content),
							$config?.audio?.tts?.split_on ?? 'punctuation'
						);
						messageContentParts.pop();

						// dispatch only last sentence and make sure it hasn't been dispatched before
						if (
							messageContentParts.length > 0 &&
							messageContentParts[messageContentParts.length - 1] !== message.lastSentence
						) {
							message.lastSentence = messageContentParts[messageContentParts.length - 1];
							eventTarget.dispatchEvent(
								new CustomEvent('chat', {
									detail: {
										id: message.id,
										content: messageContentParts[messageContentParts.length - 1]
									}
								})
							);
						}
					}
				}
			}
		}

		if (content) {
			if (applyMessageContentUpdate(message, content, 'chat:completion.content')) {
				messageUpdated = true;
				if (navigator.vibrate && ($settings?.hapticFeedback ?? false)) {
					navigator.vibrate(5);
				}

				if (shouldProcessStreamingTTS) {
					// Emit chat event for TTS only when streaming speech features are enabled.
					const messageContentParts = getMessageContentParts(
						removeAllDetails(message.content),
						$config?.audio?.tts?.split_on ?? 'punctuation'
					);
					messageContentParts.pop();

					// dispatch only last sentence and make sure it hasn't been dispatched before
					if (
						messageContentParts.length > 0 &&
						messageContentParts[messageContentParts.length - 1] !== message.lastSentence
					) {
						message.lastSentence = messageContentParts[messageContentParts.length - 1];
						eventTarget.dispatchEvent(
							new CustomEvent('chat', {
								detail: {
									id: message.id,
									content: messageContentParts[messageContentParts.length - 1]
								}
							})
						);
					}
				}
			}
		}

		if (selected_model_id) {
			if (message.selectedModelId !== selected_model_id || message.arena !== true) {
				message.selectedModelId = selected_model_id;
				message.arena = true;
				messageUpdated = true;
			}
		}

		if (usage) {
			if (applyStreamingUsageUpdate(message, usage, Boolean(done))) {
				messageUpdated = true;
			}
		}

		if (flushPendingStreamingUsageUpdate(message, Boolean(done))) {
			messageUpdated = true;
		}

		// Store contentBlocks for proper LLM context reconstruction in follow-up requests
		if (contentBlocks && contentBlocks.length > 0 && message.contentBlocks !== contentBlocks) {
			message.contentBlocks = contentBlocks;
			messageUpdated = true;
		}

		if (Array.isArray(files) && files.length > 0) {
			message.files = mergeDistinctInlineFiles(message.files, files);
			messageUpdated = true;
		}

		const observedToolCalls = Array.isArray(tool_calls) ? tool_calls : [];
		if (observedToolCalls.length > 0) {
			message.tool_calls = observedToolCalls;
			messageUpdated = true;
		} else {
			const blockToolCalls = extractToolCallsFromContentBlocks(contentBlocks);
			if (blockToolCalls.length > 0) {
				message.tool_calls = blockToolCalls;
				messageUpdated = true;
			}
		}

		if (done) {
			if (!message.done) {
				message.done = true;
				messageUpdated = true;
			}

			if (flushPendingStreamingUsageUpdate(message, true)) {
				messageUpdated = true;
			}
			delete streamUsageStateByMessageId[message.id];

			if (applyToolExecutionClaimGuardrail(message, tool_calls, contentBlocks)) {
				messageUpdated = true;
			}

			// PORTICO_PATCH: Flush the final commit BEFORE clearing state.
			// The old order called clearStreamingMessageCommitState first,
			// which deleted the state entry, then commitMessageUpdate →
			// flushPendingStreamingMessageCommit tried to read it and crashed
			// with "Cannot read properties of undefined (reading 'timerId')".
			commitMessageUpdate();

			clearStreamingMessageCommitState(message.id);

			// Portico: Clear watchdog tracking for this completed message
			clearStreamingProgressState(message.id);
			clearGenerationStateIfIdle({ clearTaskIds: delegatedSubagentView });

			if ($settings.responseAutoCopy) {
				copyToClipboard(message.content);
			}

			if ($settings.responseAutoPlayback && !$showCallOverlay) {
				await tick();
				document.getElementById(`speak-button-${message.id}`)?.click();
			}

			// Emit chat event for TTS
			const lastMessageContentPart =
				getMessageContentParts(
					removeAllDetails(message.content),
					$config?.audio?.tts?.split_on ?? 'punctuation'
				)?.at(-1) ?? '';
			if (lastMessageContentPart) {
				eventTarget.dispatchEvent(
					new CustomEvent('chat', {
						detail: { id: message.id, content: lastMessageContentPart }
					})
				);
			}
			eventTarget.dispatchEvent(
				new CustomEvent('chat:finish', {
					detail: {
						id: message.id,
						content: message.content
					}
				})
			);

			await tick();
			if (autoScroll) {
				scrollToBottom();
			}

			if (!delegatedSubagentView) {
				await chatCompletedHandler(
					chatId,
					message.model,
					message.id,
					createMessagesList(history, message.id)
				);
			}
		}

		if (DEBUG_STREAM_CHUNKS && done) {
			console.debug('[ChatCompletionDone]', data);
		}
		commitMessageUpdate();
		// Auto-scroll is handled by ResizeObserver on messagesContentElement.
		// When content grows, the observer fires post-layout and snaps to bottom.
	};

	// Portico: Stream watchdog - poll backend when socket events stall for 10s
	const STREAM_WATCHDOG_STALL_MS = 10000; // 10 seconds without a socket event
	const STREAM_WATCHDOG_CHECK_MS = 5000; // Check every 5 seconds
	const STREAM_WATCHDOG_VISIBLE_PROGRESS_MS = 30000; // 30 seconds without visible content/usage growth
	const STREAM_WATCHDOG_VISIBLE_PROGRESS_POLL_MS = 15000; // Avoid hammering when hidden deltas keep flowing

	const startStreamWatchdog = () => {
		if (streamWatchdogInterval) return; // Already running
		streamWatchdogInterval = setInterval(checkStreamWatchdog, STREAM_WATCHDOG_CHECK_MS);
		console.log('[StreamWatchdog] Started');
	};

	const stopStreamWatchdog = () => {
		if (streamWatchdogInterval) {
			clearInterval(streamWatchdogInterval);
			streamWatchdogInterval = null;
			console.log('[StreamWatchdog] Stopped');
		}
		lastSocketEventTime = {};
		lastVisibleProgressTimeByMessageId = {};
		lastInvisibleProgressPollTimeByMessageId = {};
	};

	const checkStreamWatchdog = async () => {
		if (!history?.messages || !activeChatId) return;
		if (isDocumentHidden()) return;

		const now = Date.now();
		let hasActiveStreams = false;

		for (const [msgId, message] of Object.entries(history.messages)) {
			if (message.role !== 'assistant') continue;
			if (!isAssistantMessageActive(message)) {
				if (hasAssistantTerminalError(message)) {
					const stopReason =
						resolveAssistantStopReason(message, TERMINAL_ERROR_STOP_REASON) ??
						TERMINAL_ERROR_STOP_REASON;
					if (applyLocalStopToAssistantMessage(message, stopReason)) {
						history.messages[msgId] = message;
						history = history;
					}
					clearStreamingProgressState(msgId);
					clearStreamingMessageCommitState(msgId);
				}
				continue;
			}

			hasActiveStreams = true;
			const lastEvent = lastSocketEventTime[msgId];
			const visibleProgressSeedTime = assistantMessageHasVisibleProgress(message)
				? now
				: (getAssistantMessageTimestampMs(message) ?? now);
			const lastVisibleProgress =
				lastVisibleProgressTimeByMessageId[msgId] ??
				(lastVisibleProgressTimeByMessageId[msgId] = visibleProgressSeedTime);

			// If we have no record of a socket event, start tracking from now
			if (!lastEvent) {
				lastSocketEventTime[msgId] = now;
				continue;
			}

			const stalledMs = now - lastEvent;
			const visibleProgressStalledMs = now - lastVisibleProgress;
			if (stalledMs >= STREAM_WATCHDOG_STALL_MS) {
				console.log(
					`[StreamWatchdog] Message ${msgId} stalled for ${stalledMs}ms, polling backend`
				);
				await pollBackendForMessage(msgId, 'socket_stall');
				continue;
			}

			if (visibleProgressStalledMs >= STREAM_WATCHDOG_VISIBLE_PROGRESS_MS) {
				const lastProgressPollAt = lastInvisibleProgressPollTimeByMessageId[msgId] ?? 0;
				if (now - lastProgressPollAt >= STREAM_WATCHDOG_VISIBLE_PROGRESS_POLL_MS) {
					lastInvisibleProgressPollTimeByMessageId[msgId] = now;
					console.log(
						`[StreamWatchdog] Message ${msgId} has no visible progress for ${visibleProgressStalledMs}ms, polling backend`
					);
					await pollBackendForMessage(msgId, 'visible_progress_stall');
				}
			}
		}

		// If no active streams remain, stop the watchdog
		if (!hasActiveStreams) {
			stopStreamWatchdog();
		}
	};

	const resyncRunningAssistantMessages = async (
		expectedChatId: string | null = null,
		expectedGeneration: number | null = null
	) => {
		// Instance-local currency: tiles never write the global chatId store, so
		// a global compare made every tile resync a permanent no-op (stalled
		// streams in tiles could never self-heal).
		const remainsCurrent = () =>
			!expectedChatId ||
			(activeChatId === expectedChatId &&
				(expectedGeneration === null ||
					isCurrentChatLoad(expectedGeneration, expectedChatId)));
		if (!remainsCurrent()) return;
		const activeMessageIds = getActiveAssistantMessageIds();
		if (!activeChatId || activeMessageIds.length === 0) {
			stopStreamWatchdog();
			return;
		}

		await Promise.all(
			activeMessageIds.map((messageId) =>
				pollBackendForMessage(
					messageId,
					'socket_stall',
					expectedChatId,
					expectedGeneration
				)
			)
		);
		if (!remainsCurrent()) return;

		const remainingActiveMessageIds = getActiveAssistantMessageIds();
		if (remainingActiveMessageIds.length === 0) {
			stopStreamWatchdog();
			return;
		}

		seedStreamWatchdogForActiveMessages(Date.now());
	};

	const seedStreamWatchdogForActiveMessages = (observedAt = Date.now()) => {
		const activeMessageIds = getActiveAssistantMessageIds();
		if (activeMessageIds.length === 0) {
			stopStreamWatchdog();
			return [];
		}

		for (const messageId of activeMessageIds) {
			const message = history?.messages?.[messageId];
			let seededStreamingState = false;
			if (!(messageId in lastSocketEventTime)) {
				lastSocketEventTime[messageId] = observedAt;
				seededStreamingState = true;
			}
			if (!(messageId in lastVisibleProgressTimeByMessageId)) {
				lastVisibleProgressTimeByMessageId[messageId] = assistantMessageHasVisibleProgress(message)
					? observedAt
					: (getAssistantMessageTimestampMs(message) ?? observedAt);
				seededStreamingState = true;
			}
			if (seededStreamingState) {
				composerStreamingStateVersion += 1;
			}
		}

		startStreamWatchdog();
		return activeMessageIds;
	};

	const protectBackgroundTurnMessageIds = (messageIds: string[]) => {
		for (const messageId of messageIds) {
			if (typeof messageId !== 'string' || messageId.length === 0) {
				continue;
			}
			if (history?.messages?.[messageId]) {
				protectedBackgroundTurnMessageIds.add(messageId);
			}
		}
	};

	const hydrateBackgroundTurnMessagesIntoHistory = ({
		baseHistory,
		insertedUserMessage,
		insertedAssistantMessages,
		insertedCurrentId
	}: {
		baseHistory: Record<string, any> | null | undefined;
		insertedUserMessage: Record<string, any> | null;
		insertedAssistantMessages: Record<string, any>[];
		insertedCurrentId: string | null;
	}) => {
		if (!insertedUserMessage || !baseHistory?.messages) {
			return null;
		}

		const nextHistory = cloneSerializableValue(baseHistory);
		const insertedUserChildren = new Set(
			Array.isArray(insertedUserMessage.childrenIds) ? insertedUserMessage.childrenIds : []
		);
		nextHistory.messages[insertedUserMessage.id] = {
			...(nextHistory.messages[insertedUserMessage.id] ?? {}),
			...insertedUserMessage,
			childrenIds: [...insertedUserChildren]
		};

		if (
			typeof insertedUserMessage.parentId === 'string' &&
			nextHistory.messages[insertedUserMessage.parentId]
		) {
			const parentMessage = nextHistory.messages[insertedUserMessage.parentId];
			const parentChildren = Array.isArray(parentMessage.childrenIds)
				? [...parentMessage.childrenIds]
				: [];
			if (!parentChildren.includes(insertedUserMessage.id)) {
				parentChildren.push(insertedUserMessage.id);
			}
			parentMessage.childrenIds = parentChildren;
		}

		for (const assistantMessage of insertedAssistantMessages) {
			nextHistory.messages[assistantMessage.id] = assistantMessage;
			insertedUserChildren.add(assistantMessage.id);
		}
		nextHistory.messages[insertedUserMessage.id].childrenIds = [...insertedUserChildren];

		if (insertedCurrentId) {
			nextHistory.currentId = insertedCurrentId;
		}

		return nextHistory;
	};

	const rememberBackgroundTurnInsertionPayload = ({
		userMessageId,
		assistantMessageIds,
		insertedUserMessage,
		insertedAssistantMessages,
		insertedCurrentId
	}: {
		userMessageId: string | null;
		assistantMessageIds: string[];
		insertedUserMessage: Record<string, any> | null;
		insertedAssistantMessages: Record<string, any>[];
		insertedCurrentId: string | null;
	}) => {
		if (!userMessageId || !insertedUserMessage) {
			return;
		}

		const storedPayload = {
			userMessageId,
			assistantMessageIds: [...assistantMessageIds],
			insertedUserMessage: cloneSerializableValue(insertedUserMessage),
			insertedAssistantMessages: cloneSerializableValue(insertedAssistantMessages),
			insertedCurrentId
		};

		for (const messageId of [userMessageId, ...assistantMessageIds]) {
			if (typeof messageId !== 'string' || messageId.length === 0) {
				continue;
			}
			backgroundTurnInsertionPayloadsByMessageId.set(messageId, storedPayload);
		}
	};

	const repairProtectedBackgroundTurnHistoryWithStoredPayloads = (
		backendHistory: Record<string, any> | null | undefined,
		// Default (true): only resurrect a turn the backend PARTIALLY has (the
		// drain's known lost-user-message shape). Initial chat loads pass false:
		// a hydration snapshot fetched before the first dispatch committed can
		// miss the whole remembered turn, and assigning it verbatim would clobber
		// the reconciled insertion.
		{ requirePersistedAssistant = true }: { requirePersistedAssistant?: boolean } = {}
	) => {
		if (!backendHistory?.messages || backgroundTurnInsertionPayloadsByMessageId.size === 0) {
			return { history: backendHistory, repaired: false };
		}

		let nextHistory = cloneSerializableValue(backendHistory);
		let repaired = false;
		const seenPayloads = new Set<Record<string, any>>();

		for (const payload of backgroundTurnInsertionPayloadsByMessageId.values()) {
			if (!payload || seenPayloads.has(payload)) {
				continue;
			}
			seenPayloads.add(payload);

			const insertedUserMessage = payload.insertedUserMessage ?? null;
			const insertedAssistantMessages = Array.isArray(payload.insertedAssistantMessages)
				? payload.insertedAssistantMessages
				: [];
			const userMessageId =
				typeof payload.userMessageId === 'string' ? payload.userMessageId : insertedUserMessage?.id ?? null;
			const assistantMessageIds = Array.isArray(payload.assistantMessageIds)
				? payload.assistantMessageIds.filter((messageId) => typeof messageId === 'string')
				: insertedAssistantMessages
						.map((message) => (typeof message?.id === 'string' ? message.id : null))
						.filter((messageId): messageId is string => Boolean(messageId));

			if (
				!userMessageId ||
				!insertedUserMessage ||
				assistantMessageIds.length === 0 ||
				nextHistory.messages?.[userMessageId]
			) {
				continue;
			}

			const hasAssistantAlreadyPersisted = assistantMessageIds.some(
				(messageId) => !!nextHistory.messages?.[messageId]
			);
			if (requirePersistedAssistant && !hasAssistantAlreadyPersisted) {
				continue;
			}

			const hydratedHistory = hydrateBackgroundTurnMessagesIntoHistory({
				baseHistory: nextHistory,
				insertedUserMessage,
				insertedAssistantMessages,
				insertedCurrentId:
					typeof payload.insertedCurrentId === 'string' ? payload.insertedCurrentId : null
			});
			if (!hydratedHistory) {
				continue;
			}

			nextHistory = hydratedHistory;
			repaired = true;
			console.warn(
				'[Chat] Rehydrated missing protected background-turn user message from stored insertion payload:',
				userMessageId
			);
		}

		return { history: nextHistory, repaired };
	};

	const syncHistoryWithBackend = async (chatData: Record<string, any> | null | undefined) => {
		const rawBackendHistory = chatData?.history ?? chatData?.chat?.history;
		const { history: backendHistory } = repairProtectedBackgroundTurnHistoryWithStoredPayloads(
			rawBackendHistory
		);
		if (!backendHistory?.messages) {
			return false;
		}

		const missingProtectedBackgroundTurnIds = [...protectedBackgroundTurnMessageIds].filter(
			(messageId) =>
				!!history?.messages?.[messageId] && !backendHistory?.messages?.[messageId]
		);
		if (missingProtectedBackgroundTurnIds.length > 0) {
			console.warn(
				'[Chat] Refused regressive backend sync that would drop protected background-turn message IDs:',
				missingProtectedBackgroundTurnIds
			);
			return false;
		}

		for (const messageId of [...protectedBackgroundTurnMessageIds]) {
			if (backendHistory.messages[messageId]) {
				protectedBackgroundTurnMessageIds.delete(messageId);
			}
		}

		history = JSON.parse(JSON.stringify(backendHistory));
		if (delegatedSubagentView) {
			const activeHistory = normalizeDetachedSubagentActiveHistory(history);
			if (activeHistory.changed) {
				history = activeHistory.history;
			}
		}
		const hasActiveChatTasks = Array.isArray(taskIds) && taskIds.length > 0;
		const { staleNormalizedCount } = normalizeHydratedAssistantMessages(
			history?.messages ?? null,
			{
				hasActiveChatTasks: delegatedSubagentView ? true : hasActiveChatTasks
			}
		);
		if (!delegatedSubagentView && !hasActiveChatTasks && staleNormalizedCount > 0) {
			console.warn(
				`[Chat] Normalized ${staleNormalizedCount} stale assistant message(s) during backend sync`
			);
		}
		seedStreamWatchdogForActiveMessages();
		await tick();

		if (autoScroll) {
			scrollToBottom();
		}

		return true;
	};

	const reconcileBackendStartedTurn = async (messageId: string) => {
		if (!activeChatId || !messageId) {
			return false;
		}

		if (history?.messages?.[messageId]) {
			return true;
		}

		if (reconciledBackendStartedMessageIds.has(messageId)) {
			return false;
		}

		if (backendStartedTurnReconcilePromise) {
			await backendStartedTurnReconcilePromise;
			return !!history?.messages?.[messageId];
		}

		backendStartedTurnReconcilePromise = (async () => {
			try {
				const chatData = await getChatById(localStorage.token, activeChatId);
				if (!chatData) {
					return false;
				}

				const synced = await syncHistoryWithBackend(chatData);
				await refreshPendingWork(activeChatId);
				if (!synced) {
					return false;
				}

				const didHydrateMessage = !!history?.messages?.[messageId];
				if (didHydrateMessage) {
					reconciledBackendStartedMessageIds.add(messageId);
					// Backend-started turn = a new message in this chat: snap down
					// and re-arm auto-scroll like any other insertion.
					await tick();
					autoScroll = true;
					scrollToBottom();
				}
				return didHydrateMessage;
			} catch (error) {
				console.error('[Chat] Failed to reconcile backend-started turn:', error);
				return false;
			} finally {
				backendStartedTurnReconcilePromise = null;
			}
		})();

		return await backendStartedTurnReconcilePromise;
	};

	const reconcileBackgroundTurnInsertion = async (payload: Record<string, any> | null | undefined) => {
		if (!activeChatId) {
			return false;
		}

		const consumedItemKind =
			payload?.item_kind === 'steer' || payload?.item_kind === 'queue' ? payload.item_kind : null;
		const consumedItemId =
			typeof payload?.item_id === 'string' && payload.item_id.length > 0 ? payload.item_id : null;
		const insertedUserMessage =
			payload?.user_message && typeof payload.user_message === 'object'
				? cloneSerializableValue(payload.user_message)
				: null;
		const insertedAssistantMessages = Array.isArray(payload?.assistant_messages)
			? payload.assistant_messages
					.filter((message) => message && typeof message === 'object')
					.map((message) => cloneSerializableValue(message))
			: [];
		const insertedCurrentId =
			typeof payload?.current_id === 'string' && payload.current_id.length > 0
				? payload.current_id
				: null;
		const nextPendingWorkState =
			payload?.pending_work && typeof payload.pending_work === 'object'
				? cloneSerializableValue(payload.pending_work)
				: null;
		const userMessageId =
			typeof payload?.user_message_id === 'string'
				? payload.user_message_id
				: insertedUserMessage?.id ?? null;
		const assistantMessageIds =
			Array.isArray(payload?.assistant_message_ids) && payload.assistant_message_ids.length > 0
				? payload.assistant_message_ids.filter((messageId) => typeof messageId === 'string')
				: insertedAssistantMessages
						.map((message) => (typeof message?.id === 'string' ? message.id : null))
						.filter((messageId): messageId is string => Boolean(messageId));
		const expectedMessageIds = [userMessageId, ...assistantMessageIds].filter(
			(messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0
		);

		if (consumedItemKind && consumedItemId) {
			clearDispatchedPendingWorkItemLocally({
				itemKind: consumedItemKind,
				itemId: consumedItemId
			});
		}

		rememberBackgroundTurnInsertionPayload({
			userMessageId,
			assistantMessageIds,
			insertedUserMessage,
			insertedAssistantMessages,
			insertedCurrentId
		});

		// Ancestry gap: the inserted turn references a parent this instance has
		// never seen (a freshly-started tile can miss earlier events entirely, or
		// its initial fetch can race the first dispatch). Hydrating a hole would
		// render only the tail with a permanently stuck top loader — fall through
		// to the full backend sync below, which brings the complete history.
		const insertedParentId =
			typeof insertedUserMessage?.parentId === 'string' ? insertedUserMessage.parentId : null;
		const hasAncestryGap = Boolean(
			insertedParentId && !history?.messages?.[insertedParentId]
		);
		const nextHistory =
			insertedUserMessage && history?.messages && !hasAncestryGap
				? hydrateBackgroundTurnMessagesIntoHistory({
						baseHistory: history,
						insertedUserMessage,
						insertedAssistantMessages,
						insertedCurrentId
					})
				: null;

		if (nextHistory) {
			history = nextHistory;
			protectBackgroundTurnMessageIds(expectedMessageIds);
			if (nextPendingWorkState) {
				applyPendingWorkState(nextPendingWorkState);
			}
			for (const messageId of assistantMessageIds) {
				reconciledBackendStartedMessageIds.add(messageId);
			}
			seedStreamWatchdogForActiveMessages(Date.now());
			await tick();
			// A NEW turn landing in this chat (user send, cross-chat message,
			// queued dispatch) always snaps to the bottom and RE-ARMS
			// auto-scroll — a reader parked mid-history would otherwise never
			// re-attach and the chat looks frozen mid-scroll.
			autoScroll = true;
			scrollToBottom();
			return expectedMessageIds.every((messageId) => history?.messages?.[messageId]);
		}

		if (
			expectedMessageIds.length > 0 &&
			expectedMessageIds.every((messageId) => history?.messages?.[messageId])
		) {
			protectBackgroundTurnMessageIds(expectedMessageIds);
			if (nextPendingWorkState) {
				applyPendingWorkState(nextPendingWorkState);
			} else {
				await refreshPendingWork(activeChatId);
			}
			return true;
		}

		if (backendStartedTurnReconcilePromise) {
			await backendStartedTurnReconcilePromise;
			return expectedMessageIds.every((messageId) => history?.messages?.[messageId]);
		}

		backendStartedTurnReconcilePromise = (async () => {
			try {
				const chatData = await getChatById(localStorage.token, activeChatId);
				if (!chatData) {
					return false;
				}

				const synced = await syncHistoryWithBackend(chatData);
				if (!synced) {
					return false;
				}
				if (nextPendingWorkState) {
					applyPendingWorkState(nextPendingWorkState);
				} else {
					await refreshPendingWork(activeChatId);
				}

				for (const messageId of assistantMessageIds) {
					reconciledBackendStartedMessageIds.add(messageId);
				}

				// Same re-arm as the fast-path hydration above: an inserted turn
				// snaps the view down even if the reader had scrolled up.
				await tick();
				autoScroll = true;
				scrollToBottom();
				return expectedMessageIds.every((messageId) => history?.messages?.[messageId]);
			} catch (error) {
				console.error('[Chat] Failed to reconcile inserted background turn:', error);
				return false;
			} finally {
				backendStartedTurnReconcilePromise = null;
			}
		})();

		return await backendStartedTurnReconcilePromise;
	};

	const pollBackendForMessage = async (
		messageId: string,
		reason: 'socket_stall' | 'visible_progress_stall' = 'socket_stall',
		expectedChatId: string | null = null,
		expectedGeneration: number | null = null
	) => {
		const targetChatId = expectedChatId || activeChatId;
		// Instance-local currency (see resyncRunningAssistantMessages): a global
		// compare disabled backend polling for every tile pane.
		const remainsCurrent = () =>
			!expectedChatId ||
			(activeChatId === expectedChatId &&
				(expectedGeneration === null ||
					isCurrentChatLoad(expectedGeneration, expectedChatId)));
		if (!targetChatId || !remainsCurrent()) return;
		try {
			const chatData = await getChatById(localStorage.token, targetChatId);
			if (!chatData || !remainsCurrent()) return;
			if (!expectedChatId) {
				await refreshPersistedChatState(targetChatId);
				if (!remainsCurrent()) return;
			}

			const backendHistory = chatData.history ?? chatData.chat?.history;
			if (!backendHistory?.messages) return;

			const backendMessage = backendHistory.messages[messageId];
			if (!backendMessage) return;

			const localMessage = history.messages[messageId];
			if (!localMessage || !isAssistantMessageActive(localMessage) || !remainsCurrent()) return;

			if (hasAssistantTerminalError(backendMessage)) {
				console.log(`[StreamWatchdog] Backend reports terminal error for message ${messageId}`);
				const mergedMessage = {
					...localMessage,
					...backendMessage
				};
				await finalizeAssistantErrorMessage(backendMessage.error ?? backendMessage, mergedMessage, {
					toast: true,
					scroll: false,
					stopReason:
						resolveAssistantStopReason(backendMessage, TERMINAL_ERROR_STOP_REASON) ??
						TERMINAL_ERROR_STOP_REASON
				});
				return;
			}

			if (backendMessage.done === true) {
				// Backend says done - update local state to match
				const stopReason = resolveAssistantStopReason(backendMessage, null);
				if (stopReason === 'client_disconnect') {
					console.log(`[StreamWatchdog] Message ${messageId} was interrupted by client disconnect`);
				} else {
					console.log(`[StreamWatchdog] Backend confirms message ${messageId} is done`);
				}
				const mergedMessage = {
					...localMessage,
					...backendMessage,
					done: true
				};
				applyLocalStopToAssistantMessage(
					mergedMessage,
					typeof stopReason === 'string' ? stopReason : null
				);
				if (mergedMessage.stop_reason === USER_STOP_REASON) {
					forceStoppedMessageIds.add(messageId);
					composerStreamingStateVersion += 1;
				}
				history.messages[messageId] = mergedMessage;
				history = history; // Trigger Svelte reactivity
				clearStreamingProgressState(messageId);
				clearStreamingMessageCommitState(messageId);
				bumpContextTokensVersion();

				// Clean up generation state if this was the active response
				if (generating) {
					generating = false;
					setTaskIds(null);
				}

				// Run the chat completed handler for proper cleanup
				await chatCompletedHandler(
					targetChatId,
					localMessage.model,
					messageId,
					createMessagesList(history, messageId)
				);
			} else if (backendMessage.content && backendMessage.content !== localMessage.content) {
				if (isStaleStreamingContentRegression(localMessage, backendMessage.content)) {
					if (DEBUG_CHAT_EVENTS) {
						console.debug(
							`[StreamWatchdog] Ignoring stale backend content for message ${messageId}`
						);
					}
				} else {
					// Backend has newer content - update and reset timer
					console.log(`[StreamWatchdog] Backend has newer content for message ${messageId}`);
					const mergedUsage = backendMessage.usage
						? mergePromptUsage(
								localMessage.usage as Record<string, unknown> | undefined,
								backendMessage.usage as Record<string, unknown> | undefined,
								'max'
							)
						: undefined;
					const nextMessage = {
						...localMessage,
						content: backendMessage.content,
						...(backendMessage.sources ? { sources: backendMessage.sources } : {}),
						...(mergedUsage ? { usage: mergedUsage } : {})
					};
					noteVisibleAssistantProgress(nextMessage);
					history.messages[messageId] = nextMessage;
					recordStreamingContentSnapshot(messageId, backendMessage.content);
					history = history;
					if (backendMessage.usage) {
						bumpContextTokensVersion();
					}
				}
				lastSocketEventTime[messageId] = Date.now(); // Reset stall timer
			} else if (backendMessage.usage) {
				const mergedUsage = mergePromptUsage(
					localMessage.usage as Record<string, unknown> | undefined,
					backendMessage.usage as Record<string, unknown> | undefined,
					'max'
				);
				if (
					hasMeaningfulUsageChange(
						localMessage.usage as Record<string, unknown> | undefined,
						mergedUsage
					)
				) {
					console.log(`[StreamWatchdog] Backend usage advanced for message ${messageId}`);
					const nextMessage = {
						...localMessage,
						usage: mergedUsage
					};
					noteVisibleAssistantProgress(nextMessage);
					history.messages[messageId] = nextMessage;
					history = history;
					bumpContextTokensVersion();
				}
				lastSocketEventTime[messageId] = Date.now();
			} else {
				// Backend also shows in-progress with same content - reset timer to avoid hammering
				console.log(`[StreamWatchdog] Backend also shows in-progress for message ${messageId}`);
				if (reason === 'visible_progress_stall') {
					const heartbeatMessage = history.messages[messageId];
					if (hasOpenReasoningActivity(heartbeatMessage)) {
						// Silent reasoning is known activity (the live thinking
						// indicator is showing); don't overlay the stall heartbeat.
						if (clearStreamingProgressStatus(heartbeatMessage)) {
							history.messages[messageId] = heartbeatMessage;
							history = history;
						}
					} else if (upsertStreamingProgressStatus(heartbeatMessage, Date.now())) {
						history.messages[messageId] = heartbeatMessage;
						history = history;
					}
				}
				lastSocketEventTime[messageId] = Date.now();
			}
		} catch (error) {
			console.error('[StreamWatchdog] Error polling backend:', error);
			// Reset timer to avoid hammering on error
			lastSocketEventTime[messageId] = Date.now();
		}
	};

	//////////////////////////
	// Chat functions
	//////////////////////////

	const normalizeSubmitPrompt = (value: unknown): string => {
		if (typeof value !== 'string') {
			return '';
		}

		return value.replaceAll('\n\n', '\n');
	};

	const isBlankPendingWorkDraft = () => normalizeSubmitPrompt(prompt).trim() === '' && files.length === 0;

	const getAutocompleteContextMessages = () =>
		history?.currentId ? createMessagesList(history, history.currentId) : null;

	const cloneSerializableValue = <T>(value: T): T => {
		if (typeof structuredClone === 'function') {
			return structuredClone(value);
		}

		return JSON.parse(JSON.stringify(value));
	};

	const clearDispatchedPendingWorkItemLocally = ({
		itemKind,
		itemId
	}: {
		itemKind: 'steer' | 'queue';
		itemId: string;
	}) => {
		if (!itemId) {
			return;
		}

		const nextPendingWork = cloneSerializableValue(pendingWork);
		let didClearItem = false;

		if (itemKind === 'steer' && nextPendingWork.pending_steer?.id === itemId) {
			nextPendingWork.pending_steer = null;
			didClearItem = true;
		}

		if (itemKind === 'queue') {
			const nextQueuedPrompts = nextPendingWork.queued_prompts.filter((item) => item.id !== itemId);
			if (nextQueuedPrompts.length !== nextPendingWork.queued_prompts.length) {
				nextPendingWork.queued_prompts = nextQueuedPrompts;
				didClearItem = true;
			}
		}

		if (!didClearItem) {
			return;
		}

		pendingWork = nextPendingWork;
		pendingWorkLoaded = true;

		if (editingPendingWork?.id === itemId) {
			editingPendingWork = null;
			queuedEditCursorId = null;
		}
	};

	const applyPendingWorkState = (nextState: PendingWorkState | null | undefined) => {
		const nextPendingWork = nextState ?? emptyPendingWorkState(activeChatId ?? chatIdProp ?? '');
		// Cross-pane snapshots (the composer acted on a focused tile's chat)
		// belong to that pane's published runtime, never to this instance's
		// own pendingWork — the tile's socket refresh re-confirms shortly.
		const ownChatId = String(activeChatId || chatIdProp || '').trim();
		const stateChatId = String(nextPendingWork?.chat_id || '').trim();
		if (stateChatId && ownChatId && stateChatId !== ownChatId) {
			multiChatPaneRuntime.update((runtime) => {
				const existing = runtime[stateChatId];
				if (!existing) return runtime;
				return { ...runtime, [stateChatId]: { ...existing, pendingWork: nextPendingWork } };
			});
			return;
		}
		if (!shouldApplyPendingWorkStateSnapshot(pendingWork, nextPendingWork)) {
			console.debug('[PendingWork] Ignoring stale pending-work state snapshot:', {
				current: pendingWork,
				incoming: nextPendingWork
			});
			return;
		}

		pendingWork = nextPendingWork;
		pendingWorkLoaded = true;

		if (editingPendingWork?.kind === 'steer') {
			if (!pendingWork.pending_steer || pendingWork.pending_steer.id !== editingPendingWork.id) {
				editingPendingWork = null;
				queuedEditCursorId = null;
			}
		}

		if (editingPendingWork?.kind === 'queue') {
			const stillExists = pendingWork.queued_prompts.some(
				(item) => item.id === editingPendingWork?.id
			);
			if (!stillExists) {
				editingPendingWork = null;
				queuedEditCursorId = null;
			}
		}
	};

	const refreshPendingWork = async (chatIdValue: string) => {
		if (!chatIdValue) {
			applyPendingWorkState(emptyPendingWorkState());
			return emptyPendingWorkState();
		}

		const nextState = await getChatPendingWork(localStorage.token, chatIdValue);
		applyPendingWorkState(nextState);
		return nextState;
	};

	const computeComposerStreamingState = (): ComposerStreamingState => {
		const activeStreamingMessageIds = Array.from(
			new Set([
				...Object.keys(lastSocketEventTime),
				...Object.keys(lastVisibleProgressTimeByMessageId)
			])
		);
		const streamingState = deriveComposerStreamingState({
			currentId: history?.currentId ?? null,
			messages: (history?.messages ?? null) as Record<string, any> | null,
			activeTaskIds: Array.isArray(taskIds) ? taskIds.map((taskId) => String(taskId)) : [],
			activeStreamingMessageIds,
			forceStoppedMessageIds: Array.from(forceStoppedMessageIds)
		});

		if (streamingState.usedActiveTaskFallback && streamingState.visibleTailMessageId) {
			const visibleTailMessage = history?.messages?.[streamingState.visibleTailMessageId];
			if (!composerStreamingFallbackLoggedMessageIds.has(streamingState.visibleTailMessageId)) {
				console.warn('[ComposerStreaming] Using active-task fallback for visible assistant turn', {
					chatId: activeChatId,
					currentId: history?.currentId ?? null,
					visibleTailMessageId: streamingState.visibleTailMessageId,
					visibleTailRole: visibleTailMessage?.role ?? null,
					visibleTailDone: visibleTailMessage?.done ?? null,
					visibleTailStopReason: visibleTailMessage?.stop_reason ?? null,
					taskCount: Array.isArray(taskIds) ? taskIds.length : 0
				});
				composerStreamingFallbackLoggedMessageIds.add(streamingState.visibleTailMessageId);
			}
		} else if (!streamingState.isStreaming) {
			composerStreamingFallbackLoggedMessageIds.clear();
		}

		return streamingState;
	};

	$: {
		history;
		taskIds;
		composerStreamingStateVersion;
		composerStreamingState = computeComposerStreamingState();
	}

	const getPendingWorkChatId = () => {
		// Multi-chat: when a tile has focus, ALL composer steer/queue actions
		// route to that chat — every handler resolves through this function.
		if (crossPaneTarget?.chatId) {
			return crossPaneTarget.chatId;
		}
		const resolvedChatId = String(activeChatId ?? chatIdProp ?? '').trim();
		return resolvedChatId.length > 0 ? resolvedChatId : null;
	};

	const getPendingWorkUnavailableMessage = () => {
		const pendingWorkChatId = getPendingWorkChatId();
		if ($temporaryChatEnabled || String(pendingWorkChatId ?? '').startsWith('local:')) {
			return $i18n.t('Pending steer and queued prompts are not available in temporary chats.');
		}

		if (!pendingWorkChatId) {
			return $i18n.t('Please wait for the chat to initialize before steering or queueing.');
		}

		if (crossPaneTarget && (crossPaneRuntime?.selectedModelIds ?? []).length === 0) {
			return $i18n.t('The focused chat is still loading — try again in a moment.');
		}

		return null;
	};

	// ── multi-chat cross-pane composer state ──────────────────────────────
	$: crossPaneRuntime = crossPaneTarget
		? $multiChatPaneRuntime[crossPaneTarget.chatId] ?? null
		: null;
	$: composerIsStreaming = crossPaneTarget
		? Boolean(crossPaneRuntime?.isStreaming)
		: composerStreamingState.isStreaming;
	$: composerPendingSteer = crossPaneTarget
		? crossPaneRuntime?.pendingWork?.pending_steer ?? null
		: pendingWork.pending_steer;
	$: composerQueuedPrompts = sortQueuedPromptsForDispatch(
		crossPaneTarget
			? crossPaneRuntime?.pendingWork?.queued_prompts ?? []
			: pendingWork.queued_prompts
	);

	// Switching the focused pane invalidates any in-flight steer/queue edit
	// (it referenced the previous chat's items).
	let lastCrossPaneTargetChatId = '';
	$: {
		const targetChatId = crossPaneTarget?.chatId ?? '';
		if (targetChatId !== lastCrossPaneTargetChatId) {
			lastCrossPaneTargetChatId = targetChatId;
			if (editingPendingWork) {
				void cancelPendingWorkEdit();
			}
			if (targetChatId && atSelectedModel !== undefined) {
				// An @-mentioned model override belongs to the primary's chat;
				// cross-pane dispatch ignores it, so showing its chip while a
				// tile is focused would lie about the send target's model.
				atSelectedModel = undefined;
			}
		}
	}

	// ── composer focus-swap ────────────────────────────────────────────────
	// The shared composer's widgets (model selector, reasoning effort, fast
	// mode, context/cost pill, active MCPs/skills) always describe the FOCUSED
	// pane: the primary's own state normally, the target tile's published
	// runtime while a tile is focused. Edits made while a tile is focused
	// route back to the tile as pane commands; the tile applies + persists
	// them and republishes, so this view always reflects tile truth.
	$: composerViewState = deriveComposerViewState({
		crossPaneActive: Boolean(crossPaneTarget),
		runtime: crossPaneRuntime,
		primary: {
			selectedModels,
			reasoningEffortByModel,
			reasoningEffortReady,
			fastModeEnabled,
			contextTokens,
			costMetrics: workflowCostMetrics,
			activeCapabilities
		}
	});

	// Two-way model mux: MessageInput's ModelSelector binds this variable —
	// never the primary's own selectedModels, so focus switches and target
	// edits can't trip the primary's model-change reactives (sessionStorage
	// carry-forward, tool reseeding, folder model_ids write).
	let composerSelectedModels: string[] = [''];
	let composerModelsSyncSignature = modelIdsSignature(composerSelectedModels);

	const syncComposerModelsFromSource = (
		target: typeof crossPaneTarget,
		runtime: typeof crossPaneRuntime,
		primaryModels: string[]
	) => {
		const source = target
			? (runtime?.selectedModelIds?.length ?? 0) > 0
				? (runtime?.selectedModelIds as string[])
				: ['']
			: primaryModels;
		const signature = modelIdsSignature(source);
		composerModelsSyncSignature = signature;
		if (modelIdsSignature(composerSelectedModels) !== signature) {
			composerSelectedModels = [...source];
		}
	};
	$: syncComposerModelsFromSource(crossPaneTarget, crossPaneRuntime, selectedModels);

	const handleComposerModelsChanged = (nextModelIds: string[]) => {
		const signature = modelIdsSignature(nextModelIds);
		if (signature === composerModelsSyncSignature) {
			// Echo of a downstream sync — not a user edit.
			return;
		}
		if (isTransientModelSelection(nextModelIds)) {
			// ModelSelector normalization blip (unknown id / catalog loading).
			return;
		}
		composerModelsSyncSignature = signature;
		if (crossPaneTarget) {
			postPaneCommand({
				chatId: crossPaneTarget.chatId,
				type: 'set-models',
				payload: {
					modelIds: nextModelIds.filter(
						(modelId) => typeof modelId === 'string' && modelId.length > 0
					)
				}
			});
			return;
		}
		selectedModels = [...nextModelIds];
	};
	$: handleComposerModelsChanged(composerSelectedModels);

	const handleComposerFastModeToggle = (next: boolean) => {
		if (crossPaneTarget) {
			postPaneCommand({
				chatId: crossPaneTarget.chatId,
				type: 'set-fast-mode',
				payload: { enabled: next === true }
			});
			return;
		}
		handleFastModeToggle(next);
	};

	const handleComposerReasoningEffortSelect = (selection: {
		modelIndex: number | string;
		value: string;
	}) => {
		if (crossPaneTarget) {
			postPaneCommand({
				chatId: crossPaneTarget.chatId,
				type: 'set-reasoning-effort',
				payload: selection
			});
			return;
		}
		handleReasoningEffortSelection(selection);
	};

	// Request context for messages dispatched into a tile's chat: the TARGET's
	// models, params (incl. fast-mode service tier) and resolved reasoning
	// effort as published by its pane — never the orchestrator's. tool_ids
	// (and features) are deliberately omitted — the dispatch-time backfill
	// replays the target chat's own tools, exactly like send_message_to_chat.
	const buildCrossPaneRequestContext = () =>
		buildCrossPaneRequestContextForRuntime({
			runtime: crossPaneRuntime,
			models: $models
		});

	// Plain Enter with a focused tile: deliver through the queued-prompts
	// pipeline (drains immediately when the target is idle; queues when busy).
	const dispatchCrossPaneMessage = async (normalizedPrompt: string) => {
		const target = crossPaneTarget;
		if (!target) return false;
		const unavailableMessage = getPendingWorkUnavailableMessage();
		if (unavailableMessage) {
			toast.error(unavailableMessage);
			return false;
		}
		const nextState = await appendQueuedPrompt(localStorage.token, target.chatId, {
			prompt: normalizedPrompt,
			files: JSON.parse(JSON.stringify(files)),
			request_context: buildCrossPaneRequestContext(),
			status: 'queued'
		}).catch((error) => {
			console.error('[MultiChat] Failed to send message to focused pane:', error);
			toast.error(
				extractPendingWorkErrorMessage(
					error,
					$i18n.t('Failed to send the message to the focused chat.')
				)
			);
			return null;
		});
		if (!nextState) return false;
		applyPendingWorkState(nextState);
		// Clear the composer like a normal send would (submitPrompt owns this
		// on the local path).
		prompt = '';
		messageInput?.setText('');
		files = [];
		return true;
	};

	const extractPendingWorkErrorMessage = (
		error: unknown,
		fallbackMessage: string
	): string => {
		if (typeof error === 'string' && error.trim()) {
			return error;
		}

		if (error && typeof error === 'object') {
			const detail = (error as Record<string, unknown>).detail;
			if (typeof detail === 'string' && detail.trim()) {
				return detail;
			}

			const message = (error as Record<string, unknown>).message;
			if (typeof message === 'string' && message.trim()) {
				return message;
			}
		}

		return fallbackMessage;
	};

	const validatePendingWorkComposerPayload = () => {
		const resolvedSelectedModels = resolveEnabledSelectedModelIds(selectedModels, $models ?? [], {
			fallback: true
		});
		if (JSON.stringify(selectedModels) !== JSON.stringify(resolvedSelectedModels)) {
			selectedModels = resolvedSelectedModels;
		}

		if (prompt === '' && files.length === 0) {
			toast.error($i18n.t('Please enter a prompt'));
			return false;
		}
		if (selectedModelIds.includes('')) {
			toast.error($i18n.t('Model not selected'));
			return false;
		}
		if (
			files.length > 0 &&
			files.filter((file) => file.type !== 'image' && file.status === 'uploading').length > 0
		) {
			toast.error(
				$i18n.t(`Oops! There are files still uploading. Please wait for the upload to complete.`)
			);
			return false;
		}
		if (
			($config?.file?.max_count ?? null) !== null &&
			files.length + chatFiles.length > $config?.file?.max_count
		) {
			toast.error(
				$i18n.t(`You can only chat with a maximum of {{maxCount}} file(s) at a time.`, {
					maxCount: $config?.file?.max_count
				})
			);
			return false;
		}

		return true;
	};

	const buildPendingWorkRequestContext = async (): Promise<PendingWorkRequestContext> => {
		let userLocation;
		if ($settings?.userLocation) {
			userLocation = await getAndUpdateUserLocation(localStorage.token).catch(() => undefined);
		}

		const resolvedModelIds =
			atSelectedModel?.id !== undefined
				? [atSelectedModel.id]
				: resolveEnabledSelectedModelIds(selectedModels, $models ?? [], {
						fallback: !urlSelectedModelResolutionFailed
					});

		const selectedModelItems = Object.fromEntries(
			resolvedModelIds
				.map((modelId) => {
					const model = $models.find((item) => item.id === modelId);
					return model ? [modelId, JSON.parse(JSON.stringify(model))] : null;
				})
				.filter(Boolean)
		);

		const toolIds = [];
		const toolServerIds = [];
		const activeCapabilityToolIds = getActiveCapabilityToolIdsForRequest(getPendingWorkChatId());
		for (const toolId of selectedToolIds) {
			if (toolId.startsWith('direct_server:')) {
				let serverId = toolId.replace('direct_server:', '');
				toolServerIds.push(isNaN(parseInt(serverId)) ? serverId : parseInt(serverId));
			} else {
				toolIds.push(toolId);
			}
		}

		return {
			selected_model_ids: resolvedModelIds,
			selected_model_items: selectedModelItems,
			tool_ids: [...new Set([...toolIds, ...activeCapabilityToolIds])],
			tool_servers: ($toolServers ?? []).filter(
				(server, idx) => toolServerIds.includes(idx) || toolServerIds.includes(server?.id)
			),
			filter_ids: [...selectedFilterIds],
			features: getFeatures(),
			reasoning_effort_by_model: JSON.parse(
				JSON.stringify(getResolvedReasoningEffortByModelSnapshot(resolvedModelIds))
			),
			// Portico (fast mode): queued sends capture the toggle at queue time so
			// offline drains keep the tier (rides the generic pending-work params).
			params: JSON.parse(
				JSON.stringify({
					...(params ?? {}),
					...(fastModeEnabled && hasGptFastModeModel(resolvedModelIds, $models)
						? { service_tier: FAST_MODE_SERVICE_TIER }
						: {})
				})
			),
			variables: {
				...getPromptVariables($user?.name, $settings?.userLocation ? userLocation : undefined)
			},
			background_tasks: {
				follow_up_generation: $settings?.autoFollowUps ?? true
			},
			session_id: $socket?.id ?? null
		};
	};

	const clearComposerDraft = async () => {
		prompt = '';
		files = [];
		messageInput?.setText('');
		await tick();
		document.getElementById('chat-input')?.focus();
	};

	const hydrateComposerFromPendingItem = async (item: PendingWorkItem) => {
		files = JSON.parse(JSON.stringify(item.files ?? []));
		prompt = item.prompt ?? '';
		await tick();
		messageInput?.setText(item.prompt ?? '');
		await tick();
		document.getElementById('chat-input')?.focus();
	};

	const replaceComposerWithPendingSteer = async () => {
		const pendingWorkChatId = getPendingWorkChatId();
		const currentSteer = pendingWork.pending_steer;
		if (!pendingWorkChatId || !currentSteer) return false;

		const nextState = await updatePendingSteer(localStorage.token, pendingWorkChatId, {
			id: currentSteer.id,
			prompt: currentSteer.prompt,
			files: currentSteer.files ?? [],
			status: 'editing'
		}).catch((error) => {
			console.error('[PendingWork] Failed to mark pending steer editing:', error);
			return null;
		});

		if (!nextState) return false;

		applyPendingWorkState(nextState);
		queuedEditCursorId = null;
		editingPendingWork = { kind: 'steer', id: currentSteer.id };
		await hydrateComposerFromPendingItem(currentSteer);
		return true;
	};

	const persistEditingPendingSteer = async ({
		nextStatus = 'editing'
	}: { nextStatus?: string } = {}) => {
		const pendingWorkChatId = getPendingWorkChatId();
		if (!pendingWorkChatId || editingPendingWork?.kind !== 'steer') {
			return;
		}

		await updatePendingSteer(localStorage.token, pendingWorkChatId, {
			id: editingPendingWork.id,
			prompt,
			files: JSON.parse(JSON.stringify(files)),
			status: nextStatus
		}).catch((error) => {
			console.error('[PendingWork] Failed to persist pending steer edit:', error);
		});
	};

	const persistEditingQueuedPrompt = async ({
		nextStatus = 'queued'
	}: { nextStatus?: string } = {}) => {
		const pendingWorkChatId = getPendingWorkChatId();
		if (!pendingWorkChatId || editingPendingWork?.kind !== 'queue') {
			return;
		}

		await updateQueuedPrompt(localStorage.token, pendingWorkChatId, editingPendingWork.id, {
			prompt,
			files: JSON.parse(JSON.stringify(files)),
			status: nextStatus
		}).catch((error) => {
			console.error('[PendingWork] Failed to persist queued prompt edit:', error);
		});
	};

	const rotateQueuedPromptIntoComposer = async (direction: 'previous' | 'next' = 'previous') => {
		const pendingWorkChatId = getPendingWorkChatId();
		if (!pendingWorkChatId || pendingWork.queued_prompts.length === 0) return false;

		const nextTarget = getQueuedPromptEditTarget(
			pendingWork.queued_prompts,
			editingPendingWork?.kind === 'queue' ? editingPendingWork.id : queuedEditCursorId,
			direction
		);
		if (!nextTarget) return false;

		if (editingPendingWork?.kind === 'queue' && editingPendingWork.id !== nextTarget.id) {
			await persistEditingQueuedPrompt({ nextStatus: 'queued' });
		}

		const nextState = await updateQueuedPrompt(localStorage.token, pendingWorkChatId, nextTarget.id, {
			prompt: nextTarget.prompt,
			files: nextTarget.files ?? [],
			status: 'editing'
		}).catch((error) => {
			console.error('[PendingWork] Failed to mark queued prompt editing:', error);
			return null;
		});

		if (!nextState) return false;

		applyPendingWorkState(nextState);
		queuedEditCursorId = nextTarget.id;
		editingPendingWork = { kind: 'queue', id: nextTarget.id };
		await hydrateComposerFromPendingItem(nextTarget);
		return true;
	};

	const cancelPendingSteerEdit = async () => {
		const pendingWorkChatId = getPendingWorkChatId();
		if (!pendingWorkChatId || editingPendingWork?.kind !== 'steer' || !pendingWork.pending_steer) {
			return false;
		}

		const currentSteer = pendingWork.pending_steer;
		const nextState = await updatePendingSteer(localStorage.token, pendingWorkChatId, {
			id: currentSteer.id,
			prompt: currentSteer.prompt,
			files: currentSteer.files ?? [],
			status: 'active'
		}).catch((error) => {
			console.error('[PendingWork] Failed to cancel pending steer edit:', error);
			return null;
		});

		if (!nextState) return false;

		editingPendingWork = null;
		queuedEditCursorId = null;
		applyPendingWorkState(nextState);
		await clearComposerDraft();
		return true;
	};

	const cancelQueuedPromptEdit = async () => {
		const pendingWorkChatId = getPendingWorkChatId();
		if (!pendingWorkChatId || editingPendingWork?.kind !== 'queue') {
			return false;
		}

		const currentQueuedPrompt = pendingWork.queued_prompts.find(
			(item) => item.id === editingPendingWork?.id
		);
		if (!currentQueuedPrompt) {
			editingPendingWork = null;
			queuedEditCursorId = null;
			await clearComposerDraft();
			return false;
		}

		const nextState = await updateQueuedPrompt(
			localStorage.token,
			pendingWorkChatId,
			currentQueuedPrompt.id,
			{
				prompt: currentQueuedPrompt.prompt,
				files: currentQueuedPrompt.files ?? [],
				status: 'queued'
			}
		).catch((error) => {
			console.error('[PendingWork] Failed to cancel queued prompt edit:', error);
			return null;
		});

		if (!nextState) return false;

		editingPendingWork = null;
		queuedEditCursorId = null;
		applyPendingWorkState(nextState);
		await clearComposerDraft();
		return true;
	};

	const cancelPendingWorkEdit = async () => {
		if (editingPendingWork?.kind === 'steer') {
			return await cancelPendingSteerEdit();
		}
		if (editingPendingWork?.kind === 'queue') {
			return await cancelQueuedPromptEdit();
		}
		return false;
	};

	const cancelPendingSteerItem = async () => {
		const pendingWorkChatId = getPendingWorkChatId();
		if (!pendingWorkChatId || !pendingWork.pending_steer) return;
		const itemId = pendingWork.pending_steer.id;
		const nextState = await deletePendingSteer(localStorage.token, pendingWorkChatId, itemId).catch((error) => {
			console.error('[PendingWork] Failed to cancel pending steer:', error);
			return null;
		});
		if (!nextState) return;
		if (editingPendingWork?.kind === 'steer' && editingPendingWork.id === itemId) {
			editingPendingWork = null;
			queuedEditCursorId = null;
			await clearComposerDraft();
		}
		applyPendingWorkState(nextState);
	};

	const cancelQueuedPromptItem = async (itemId: string) => {
		const pendingWorkChatId = getPendingWorkChatId();
		if (!pendingWorkChatId) return;
		const nextState = await deleteQueuedPrompt(localStorage.token, pendingWorkChatId, itemId).catch((error) => {
			console.error('[PendingWork] Failed to cancel queued prompt:', error);
			return null;
		});
		if (!nextState) return;
		if (editingPendingWork?.kind === 'queue' && editingPendingWork.id === itemId) {
			editingPendingWork = null;
			queuedEditCursorId = null;
			await clearComposerDraft();
		}
		applyPendingWorkState(nextState);
	};

	const submitPendingSteerFromComposer = async () => {
		const pendingWorkUnavailableMessage = getPendingWorkUnavailableMessage();
		if (pendingWorkUnavailableMessage) {
			toast.error(pendingWorkUnavailableMessage);
			return false;
		}
		const pendingWorkChatId = getPendingWorkChatId();
		if (!pendingWorkChatId) return false;
		const shouldDeleteEditedSteer =
			editingPendingWork?.kind === 'steer' && isBlankPendingWorkDraft();
		if (!shouldDeleteEditedSteer && !validatePendingWorkComposerPayload()) return false;

		const requestContext = shouldDeleteEditedSteer
			? null
			: crossPaneTarget
				? buildCrossPaneRequestContext()
				: await buildPendingWorkRequestContext();
		const normalizedPrompt = shouldDeleteEditedSteer ? '' : normalizeSubmitPrompt(prompt);
		let nextState: PendingWorkState | null = null;

		if (editingPendingWork?.kind === 'steer') {
			if (shouldDeleteEditedSteer) {
				nextState = await deletePendingSteer(
					localStorage.token,
					pendingWorkChatId,
					editingPendingWork.id
				).catch((error) => {
					console.error('[PendingWork] Failed to delete pending steer:', error);
					toast.error(
						extractPendingWorkErrorMessage(
							error,
							$i18n.t('Failed to delete pending steer.')
						)
					);
					return null;
				});
			} else {
				nextState = await updatePendingSteer(localStorage.token, pendingWorkChatId, {
					id: editingPendingWork.id,
					prompt: normalizedPrompt,
					files: JSON.parse(JSON.stringify(files)),
					request_context: requestContext,
					status: 'active'
				}).catch((error) => {
					console.error('[PendingWork] Failed to update pending steer:', error);
					toast.error(
						extractPendingWorkErrorMessage(
							error,
							$i18n.t('Failed to update pending steer.')
						)
					);
					return null;
				});
			}
		} else {
			nextState = await replacePendingSteer(localStorage.token, pendingWorkChatId, {
				prompt: normalizedPrompt,
				files: JSON.parse(JSON.stringify(files)),
				request_context: requestContext,
				status: 'active'
			}).catch((error) => {
				console.error('[PendingWork] Failed to create pending steer:', error);
				toast.error(
					extractPendingWorkErrorMessage(
						error,
						$i18n.t('Failed to create pending steer.')
					)
				);
				return null;
			});
		}

		if (!nextState) return false;

		queuedEditCursorId = null;
		editingPendingWork = null;
		applyPendingWorkState(nextState);
		await clearComposerDraft();
		return true;
	};

	const submitQueuedPromptFromComposer = async () => {
		const pendingWorkUnavailableMessage = getPendingWorkUnavailableMessage();
		if (pendingWorkUnavailableMessage) {
			toast.error(pendingWorkUnavailableMessage);
			return false;
		}
		const pendingWorkChatId = getPendingWorkChatId();
		if (!pendingWorkChatId) return false;
		const shouldDeleteEditedQueueItem =
			editingPendingWork?.kind === 'queue' && isBlankPendingWorkDraft();
		if (!shouldDeleteEditedQueueItem && !validatePendingWorkComposerPayload()) return false;

		const requestContext = shouldDeleteEditedQueueItem
			? null
			: crossPaneTarget
				? buildCrossPaneRequestContext()
				: await buildPendingWorkRequestContext();
		const normalizedPrompt = shouldDeleteEditedQueueItem ? '' : normalizeSubmitPrompt(prompt);
		let nextState: PendingWorkState | null = null;

		if (editingPendingWork?.kind === 'queue') {
			if (shouldDeleteEditedQueueItem) {
				nextState = await deleteQueuedPrompt(
					localStorage.token,
					pendingWorkChatId,
					editingPendingWork.id
				).catch((error) => {
					console.error('[PendingWork] Failed to delete queued prompt:', error);
					toast.error(
						extractPendingWorkErrorMessage(
							error,
							$i18n.t('Failed to delete queued prompt.')
						)
					);
					return null;
				});
			} else {
				nextState = await updateQueuedPrompt(
					localStorage.token,
					pendingWorkChatId,
					editingPendingWork.id,
					{
						prompt: normalizedPrompt,
						files: JSON.parse(JSON.stringify(files)),
						request_context: requestContext,
						status: 'queued'
					}
				).catch((error) => {
					console.error('[PendingWork] Failed to update queued prompt:', error);
					toast.error(
						extractPendingWorkErrorMessage(
							error,
							$i18n.t('Failed to update queued prompt.')
						)
					);
					return null;
				});
			}
		} else {
			nextState = await appendQueuedPrompt(localStorage.token, pendingWorkChatId, {
				prompt: normalizedPrompt,
				files: JSON.parse(JSON.stringify(files)),
				request_context: requestContext,
				status: 'queued'
			}).catch((error) => {
				console.error('[PendingWork] Failed to append queued prompt:', error);
				toast.error(
					extractPendingWorkErrorMessage(
						error,
						$i18n.t('Failed to queue prompt.')
					)
				);
				return null;
			});
		}

		if (!nextState) return false;

		queuedEditCursorId = null;
		editingPendingWork = null;
		applyPendingWorkState(nextState);
		await clearComposerDraft();
		return true;
	};

	const submitPrompt = async (
		userPrompt,
		{ _raw = false, _toolConfirmationBatchSend = false }: { _raw?: boolean; _toolConfirmationBatchSend?: boolean } = {}
	) => {
		if (delegatedSubagentView) return;
		console.log('submitPrompt', userPrompt, activeChatId);

		// PORTICO PATCH (N-012): batch-send turns carry their flag through
		// the function parameter ``_toolConfirmationBatchSend``; the
		// "Please enter a prompt" check below is relaxed for them since
		// the user clicked chips rather than typing text, and the backend
		// synthesis note is what the model will actually react to.

		const _selectedModels = resolveEnabledSelectedModelIds(selectedModels, $models ?? [], {
			fallback: !urlSelectedModelResolutionFailed
		});

		if (JSON.stringify(selectedModels) !== JSON.stringify(_selectedModels)) {
			selectedModels = _selectedModels;
		}

		if (userPrompt === '' && files.length === 0 && !_toolConfirmationBatchSend) {
			toast.error($i18n.t('Please enter a prompt'));
			return;
		}
		if (selectedModels.includes('')) {
			toast.error($i18n.t('Model not selected'));
			return;
		}

		if (
			files.length > 0 &&
			files.filter((file) => file.type !== 'image' && file.status === 'uploading').length > 0
		) {
			toast.error(
				$i18n.t(`Oops! There are files still uploading. Please wait for the upload to complete.`)
			);
			return;
		}

		if (
			($config?.file?.max_count ?? null) !== null &&
			files.length + chatFiles.length > $config?.file?.max_count
		) {
			toast.error(
				$i18n.t(`You can only chat with a maximum of {{maxCount}} file(s) at a time.`, {
					maxCount: $config?.file?.max_count
				})
			);
			return;
		}

		if (history?.currentId) {
			const lastMessage = history.messages[history.currentId];
			if (lastMessage.done != true) {
				// Response not done
				return;
			}
		}

		messageInput?.setText('');
		prompt = '';

		// PORTICO PATCH (N-012): clear the chip list at submit time. Two cases:
		//
		//   * Batch-send turn (auto-fire path): every chip is already in a
		//     terminal state and the synthesized resolution note rides along
		//     on this request; the conversation history will carry the
		//     per-chip outcome for the user's review.
		//   * Hand-typed reply: the backend's ``consume_user_turn`` drops
		//     ALL pendings (TTL=1 turn — the original Slack-incident
		//     invariant). Mirror by clearing here.
		pendingToolConfirmations = [];

		const messages = createMessagesList(history, history.currentId);
		const _files = JSON.parse(JSON.stringify(files));

		chatFiles.push(
			..._files.filter(
				(item) =>
					['doc', 'text', 'note', 'chat', 'folder', 'collection'].includes(item.type) ||
					(item.type === 'file' && !(item?.content_type ?? '').startsWith('image/'))
			)
		);
		chatFiles = chatFiles.filter(
			// Remove duplicates
			(item, index, array) =>
				array.findIndex((i) => JSON.stringify(i) === JSON.stringify(item)) === index
		);

		files = [];
		messageInput?.setText('');

		// Create user message
		let userMessageId = uuidv4();
		let userMessage = {
			id: userMessageId,
			parentId: messages.length !== 0 ? messages.at(-1).id : null,
			childrenIds: [],
			role: 'user',
			content: userPrompt,
			files: _files.length > 0 ? _files : undefined,
			timestamp: Math.floor(Date.now() / 1000), // Unix epoch
			models: selectedModels
		};

		// Add message to history and Set currentId to messageId
		history.messages[userMessageId] = userMessage;
		history.currentId = userMessageId;

		// Append messageId to childrenIds of parent message
		if (messages.length !== 0) {
			history.messages[messages.at(-1).id].childrenIds.push(userMessageId);
		}

		history = history;
		await tick();

		if (autoScroll) {
			scrollToBottom();
		}

		// focus on chat input
		const chatInput = document.getElementById('chat-input');
		chatInput?.focus();

		saveSessionSelectedModels();

		const reasoningEffortByModelSnapshot =
			getResolvedReasoningEffortByModelSnapshot(_selectedModels);
		await sendMessage(history, userMessageId, {
			newChat: true,
			toolConfirmationBatchSend: _toolConfirmationBatchSend,
			reasoningEffortByModelSnapshot
		});
	};

	const sendMessage = async (
		_history,
		parentId: string,
		{
			messages = null,
			modelId = null,
			modelIdx = null,
			newChat = false,
			toolConfirmationBatchSend: _toolConfirmationBatchSend = false,
			reasoningEffortByModelSnapshot = null
		}: {
			messages?: any[] | null;
			modelId?: string | null;
			modelIdx?: number | null;
			newChat?: boolean;
			toolConfirmationBatchSend?: boolean;
			reasoningEffortByModelSnapshot?: Record<string, string> | null;
		} = {}
	) => {
		if (delegatedSubagentView) return;
		if (autoScroll) {
			scrollToBottom();
		}

		let _chatId = activeChatId;
		if (_chatId) {
			tabActivityChatId = _chatId;
		}

		const responseMessageIds: Record<PropertyKey, string> = {};
		// If modelId is provided, use it, else use selected model
		let selectedModelIds = modelId
			? [modelId]
			: atSelectedModel !== undefined
				? [atSelectedModel.id]
				: selectedModels;
		const effectiveReasoningEffortByModelSnapshot =
			reasoningEffortByModelSnapshot ??
			getResolvedReasoningEffortByModelSnapshot(selectedModelIds);

		// Create response messages for each selected model
		for (const [_modelIdx, modelId] of selectedModelIds.entries()) {
			const model = $models.filter((m) => m.id === modelId).at(0);
			const resolvedModelIdx = modelIdx ?? _modelIdx;

			if (model) {
				const responseStartedAt = Date.now();
				let responseMessageId = uuidv4();
				let responseMessage = {
					parentId: parentId,
					id: responseMessageId,
					childrenIds: [],
					role: 'assistant',
					content: '',
					done: false,
					model: model.id,
					modelName: model.name ?? model.id,
					modelIdx: resolvedModelIdx,
					timestamp: Math.floor(responseStartedAt / 1000), // Unix epoch
					streamStartedAt: responseStartedAt
				};

				// Add message to history and Set currentId to messageId
				history.messages[responseMessageId] = responseMessage;
				history.currentId = responseMessageId;
				lastVisibleProgressTimeByMessageId[responseMessageId] = Date.now();
				delete lastInvisibleProgressPollTimeByMessageId[responseMessageId];

				// Append messageId to childrenIds of parent message
				if (parentId !== null && history.messages[parentId]) {
					// Add null check before accessing childrenIds
					history.messages[parentId].childrenIds = [
						...history.messages[parentId].childrenIds,
						responseMessageId
					];
				}

				responseMessageIds[`${modelId}-${resolvedModelIdx}`] = responseMessageId;
			}
		}
		history = history;

		await tick();

		if (autoScroll) {
			scrollToBottom();
		}

		const historySnapshot = cloneSerializableValue(history);

		// Create new chat if newChat is true and first user message
		if (newChat && historySnapshot.messages[parentId]?.parentId === null) {
			_chatId = await initChatHandler(historySnapshot);
		}
		if (_chatId) {
			tabActivityChatId = _chatId;
		}

		try {
			await reconcileWorkspaceVmsBeforeExecution(_chatId);
		} catch (error) {
			toast.error(error?.message || $i18n.t('Failed to apply selected workspace folder'));
			throw error;
		}

		// Save chat after all messages have been created
		await saveChatHandler(_chatId, historySnapshot, {
			modelIdsSnapshot: selectedModelIds,
			reasoningEffortByModelSnapshot: effectiveReasoningEffortByModelSnapshot
		});

		await Promise.all(
			selectedModelIds.map(async (modelId, _modelIdx) => {
				console.log('modelId', modelId);
				const model = $models.filter((m) => m.id === modelId).at(0);
				const resolvedModelIdx = modelIdx ?? _modelIdx;

				if (model) {
					// If there are image files, check if model is vision capable
					const hasImages = createMessagesList(historySnapshot, parentId).some((message) =>
						message.files?.some(
							(file) => file.type === 'image' || file?.content_type?.startsWith('image/')
						)
					);

					if (hasImages && !(model.info?.meta?.capabilities?.vision ?? true)) {
						toast.error(
							$i18n.t('Model {{modelName}} is not vision capable', {
								modelName: model.name ?? model.id
							})
						);
					}

					let responseMessageId = responseMessageIds[`${modelId}-${resolvedModelIdx}`];
					const chatEventEmitter = await getChatEventEmitter(model.id, _chatId);

					scrollToBottom();
					await sendMessageSocket(
						model,
						messages && messages.length > 0
							? messages
							: createMessagesList(historySnapshot, responseMessageId),
						historySnapshot,
						responseMessageId,
						_chatId,
						resolvedModelIdx,
						effectiveReasoningEffortByModelSnapshot,
						_toolConfirmationBatchSend
					);

					if (chatEventEmitter) clearInterval(chatEventEmitter);
				} else {
					toast.error($i18n.t(`Model {{modelId}} not found`, { modelId }));
				}
			})
		);

		await refreshChatListPageOne(localStorage.token);
	};

	const getFeatures = () => {
		let features = {};

		if ($config?.features)
			features = {
				voice: $showCallOverlay,
				image_generation:
					$config?.features?.enable_image_generation &&
					($user?.role === 'admin' || $user?.permissions?.features?.image_generation)
						? imageGenerationEnabled
						: false,
				code_interpreter:
					$config?.features?.enable_code_interpreter &&
					($user?.role === 'admin' || $user?.permissions?.features?.code_interpreter)
						? codeInterpreterEnabled
						: false,
				web_search:
					$config?.features?.enable_web_search &&
					($user?.role === 'admin' || $user?.permissions?.features?.web_search)
						? webSearchEnabled
						: false
			};

		const currentModels = atSelectedModel?.id ? [atSelectedModel.id] : selectedModels;
		if (
			currentModels.filter(
				(model) => $models.find((m) => m.id === model)?.info?.meta?.capabilities?.web_search ?? true
			).length === currentModels.length
		) {
			if ($config?.features?.enable_web_search && ($settings?.webSearch ?? false) === 'always') {
				features = { ...features, web_search: true };
			}
		}

		if ($settings?.memory ?? false) {
			features = { ...features, memory: true };
		}

		return features;
	};

	const sendMessageSocket = async (
		model,
		_messages,
		_history,
		responseMessageId,
		_chatId,
		modelIdx = 0,
		reasoningEffortByModelSnapshot: Record<string, string> | null = null,
		_toolConfirmationBatchSend = false
	) => {
		if (delegatedSubagentView) return;
		// Alias the underscore-prefixed parameter so the request-body spread
		// reads naturally; tool-confirmation chip-test regression guard 19
		// forbids the underscored form appearing inside the spread literal.
		const toolConfirmationBatchSend = _toolConfirmationBatchSend;
			if (forceStoppedMessageIds.delete(responseMessageId)) {
				composerStreamingStateVersion += 1;
			}
			const responseMessage = _history.messages[responseMessageId];
			const userMessage = _history.messages[responseMessage.parentId];

		const chatMessageFiles = _messages
			.filter((message) => message.files)
			.flatMap((message) => message.files);

		// Filter chatFiles to only include files that are in the chatMessageFiles
		chatFiles = chatFiles.filter((item) => {
			const fileExists = chatMessageFiles.some((messageFile) => messageFile.id === item.id);
			return fileExists;
		});

		let files = JSON.parse(JSON.stringify(chatFiles));
		files.push(
			...(userMessage?.files ?? []).filter(
				(item) =>
					['doc', 'text', 'note', 'chat', 'collection'].includes(item.type) ||
					(item.type === 'file' && !(item?.content_type ?? '').startsWith('image/'))
			)
		);
		// Remove duplicates
		files = files.filter(
			(item, index, array) =>
				array.findIndex((i) => JSON.stringify(i) === JSON.stringify(item)) === index
		);

		scrollToBottom();
		eventTarget.dispatchEvent(
			new CustomEvent('chat:start', {
				detail: {
					id: responseMessageId
				}
			})
		);
		await tick();

		let userLocation;
		if ($settings?.userLocation) {
			userLocation = await getAndUpdateUserLocation(localStorage.token).catch((err) => {
				console.error(err);
				return undefined;
			});
		}

		const stream =
			model?.info?.params?.stream_response ??
			$settings?.params?.stream_response ??
			params?.stream_response ??
			true;

		let messages = [
			params?.system || $settings.system
				? {
						role: 'system',
						content: `${params?.system ?? $settings?.system ?? ''}`
					}
				: undefined,
			..._messages.map((message) => ({
				...message,
				content: processDetails(message.content)
			}))
		].filter((message) => message);

		messages = messages
			.map((message, idx, arr) => {
				const imageFiles = (message?.files ?? []).filter(
					(file) => file.type === 'image' || (file?.content_type ?? '').startsWith('image/')
				);

				return {
					role: message.role,
					...(message.contentBlocks && {
						contentBlocks: message.contentBlocks
					}), // Preserve contentBlocks for Phoenix observability and proper LLM context
					...(message.role === 'user' && imageFiles.length > 0
						? {
								content: [
									{
										type: 'text',
										text: message?.merged?.content ?? message.content
									},
									...imageFiles.map((file) => ({
										type: 'image_url',
										image_url: {
											url: file.url
										}
									}))
								]
							}
						: {
								content: message?.merged?.content ?? message.content
							})
				};
			})
			.filter((message) => message?.role === 'user' || message?.content?.trim());

		const toolIds = [];
		const toolServerIds = [];
		const activeCapabilityToolIds = getActiveCapabilityToolIdsForRequest(
			String(activeChatId ?? chatIdProp ?? '').trim()
		);

		for (const toolId of selectedToolIds) {
			if (toolId.startsWith('direct_server:')) {
				let serverId = toolId.replace('direct_server:', '');
				// Check if serverId is a number
				if (!isNaN(parseInt(serverId))) {
					toolServerIds.push(parseInt(serverId));
				} else {
					toolServerIds.push(serverId);
				}
			} else {
				toolIds.push(toolId);
			}
		}

		const resolvedReasoningEffort =
			sanitizeReasoningEffortByModel(reasoningEffortByModelSnapshot)[String(modelIdx)] ?? null;

		// PORTICO PATCH (N-012): the batch-send flag rides along on this chat
		// completion request body so the backend's
		// ``_resolve_pending_tool_confirmations`` can run the synthesis path
		// (``Gate.pop_resolutions_for_batch`` + injected system note)
		// instead of the natural-language resolver. The flag is the
		// function parameter ``_toolConfirmationBatchSend``; we don't need
		// a separate chat-scoped staged variable because the auto-fire
		// caller passes the flag through directly.

		const completionRequest = () =>
			generateOpenAIChatCompletion(
				localStorage.token,
				{
					stream: stream,
					model: model.id,
					messages: messages,
					params: {
						...$settings?.params,
						...params,
						stop:
							(params?.stop ?? $settings?.params?.stop ?? undefined)
								? (
										params?.stop.split(',').map((token) => token.trim()) ?? $settings.params.stop
									).map((str) =>
										decodeURIComponent(JSON.parse('"' + str.replace(/\"/g, '\\"') + '"'))
									)
								: undefined,
						// Portico: Pass per-model reasoning effort to control model thinking depth
						// Use index-based key to support duplicate models (same model selected twice)
						reasoning_effort: resolvedReasoningEffort ?? undefined,
						// Portico (fast mode): per-slot OpenAI service tier — set only when the
						// lightning toggle is on AND this slot's model resolves to a GPT base.
						// OWUI middleware flattens params.* to the top-level request body.
						service_tier: deriveServiceTierParam({
							fastModeEnabled,
							model,
							models: $models
						})
					},

					files: (files?.length ?? 0) > 0 ? files : undefined,

					filter_ids: selectedFilterIds.length > 0 ? selectedFilterIds : undefined,
					tool_ids:
						toolIds.length > 0 || activeCapabilityToolIds.length > 0
							? [...new Set([...toolIds, ...activeCapabilityToolIds])]
							: undefined,
					tool_servers: ($toolServers ?? []).filter(
						(server, idx) => toolServerIds.includes(idx) || toolServerIds.includes(server?.id)
					),
					features: getFeatures(),
					variables: {
						...getPromptVariables($user?.name, $settings?.userLocation ? userLocation : undefined)
					},
					model_item: $models.find((m) => m.id === model.id),

					session_id: $socket?.id,
					chat_id: _chatId,

					id: responseMessageId,
					parent_id: userMessage?.id ?? null,
					parent_message: userMessage,

					background_tasks: {
						...(!$temporaryChatEnabled &&
						(messages.length == 1 ||
							(messages.length == 2 &&
								messages.at(0)?.role === 'system' &&
								messages.at(1)?.role === 'user')) &&
						(selectedModels[0] === model.id || atSelectedModel !== undefined)
							? {
									title_generation: $settings?.title?.auto ?? true,
									tags_generation: $settings?.autoTags ?? true
								}
							: {}),
						follow_up_generation: $settings?.autoFollowUps ?? true
					},

					...(stream && (model.info?.meta?.capabilities?.usage ?? false)
						? {
								stream_options: {
									include_usage: true
								}
							}
						: {})
					,
					// PORTICO PATCH (N-012): batch-send marker. When true, the
					// backend's ``_resolve_pending_tool_confirmations`` calls
					// ``Gate.pop_resolutions_for_batch`` and injects a hidden
					// system note describing each chip's outcome (approve /
					// cancel / modify-with-payload) for the model.
					...(toolConfirmationBatchSend
						? { tool_confirmation_batch_send: true }
						: {})
				},
				`${WEBUI_BASE_URL}/api`
			);

			let res;
			try {
				res = await completionRequest();
			} catch (error) {
				if (forceStoppedMessageIds.has(responseMessageId)) {
					return;
				}
				await handleChatRequestError(error, responseMessage, responseMessageId);
				return;
			}

			if (forceStoppedMessageIds.has(responseMessageId)) {
				return;
			}

			if (res) {
				if (res.error) {
					await handleOpenAIError(res.error, responseMessage);
				} else {
					appendTaskId(res.task_id);

					// Portico: Start stream watchdog to detect stalled socket events
					lastSocketEventTime[responseMessageId] = Date.now();
					lastVisibleProgressTimeByMessageId[responseMessageId] ??= Date.now();
					composerStreamingStateVersion += 1;
					startStreamWatchdog();
				}
			}

		await tick();
		scrollToBottom();
	};

	const handleOpenAIError = async (error, responseMessage) => {
		await finalizeAssistantErrorMessage(error, responseMessage, {
			toast: true,
			scroll: true,
			stopReason: TERMINAL_ERROR_STOP_REASON
		});
	};

	const beforeUnloadHandler = (event: BeforeUnloadEvent) => {
		if (hasActiveGenerationTask()) {
			event.preventDefault();
			// Required for browser unload warning behavior.
			event.returnValue = '';
		}
	};

		const stopResponse = async () => {
			if (delegatedSubagentView) return;
			let taskIdsToStop = Array.isArray(taskIds)
				? [...new Set(taskIds.filter((taskId) => taskId).map((taskId) => String(taskId)))]
				: [];

			// Optimistic local stop: freeze all active UI blocks immediately.
			applyImmediateStopState(USER_STOP_REASON);

			if (taskIdsToStop.length === 0 && activeChatId) {
				const taskRes = await getTaskIdsByChatId(localStorage.token, activeChatId).catch(() => null);
				if (taskRes?.task_ids) {
					taskIdsToStop = [
						...new Set(taskRes.task_ids.filter((taskId) => taskId).map((taskId) => String(taskId)))
					];
				}
			}

			await stopTasksBestEffort(taskIdsToStop);

			if (autoScroll) {
				scrollToBottom();
			}
		};

	const submitMessage = async (parentId, prompt) => {
		if (delegatedSubagentView) return;
		let userPrompt = prompt;
		let userMessageId = uuidv4();

		let userMessage = {
			id: userMessageId,
			parentId: parentId,
			childrenIds: [],
			role: 'user',
			content: userPrompt,
			models: selectedModels,
			timestamp: Math.floor(Date.now() / 1000) // Unix epoch
		};

		if (parentId !== null) {
			history.messages[parentId].childrenIds = [
				...history.messages[parentId].childrenIds,
				userMessageId
			];
		}

		history.messages[userMessageId] = userMessage;
		history.currentId = userMessageId;
		history = history;

		await tick();

		if (autoScroll) {
			scrollToBottom();
		}

		await sendMessage(history, userMessageId);
	};

	const regenerateResponse = async (message, suggestionPrompt = null) => {
		if (delegatedSubagentView) return;
		console.log('regenerateResponse');

		if (history.currentId) {
			let userMessage = history.messages[message.parentId];

			if (autoScroll) {
				scrollToBottom();
			}

			await sendMessage(history, userMessage.id, {
				...(suggestionPrompt
					? {
							messages: [
								...createMessagesList(history, message.id),
								{
									role: 'user',
									content: suggestionPrompt
								}
							]
						}
					: {}),
				...((userMessage?.models ?? [...selectedModels]).length > 1
					? {
							// If multiple models are selected, use the model from the message
							modelId: message.model,
							modelIdx: message.modelIdx
						}
					: {})
			});
		}
	};

	// PORTICO PATCH (fork-chat): fork the conversation at an assistant message into a
	// new chat; the shell opens it in a new tab (or redirects the active tab at the
	// tab cap), with an in-place goto fallback outside the main-window shell.
	const forkChat = async (message) => {
		if (delegatedSubagentView) return;
		try {
			const baseTitle = String($chatTitle || '').trim() || $i18n.t('New Chat');
			const forkTitle = $i18n.t('Fork of {{TITLE}}', { TITLE: baseTitle });

			const payload = buildForkedChatPayload({
				history,
				messageId: message.id,
				id: uuidv4(),
				title: forkTitle,
				models: selectedModels,
				system: chat?.chat?.system ?? $settings?.system ?? undefined,
				params,
				files: chatFiles,
				sourceChatId: activeChatId,
				timestamp: Date.now()
			});
			if (!payload) {
				toast.error($i18n.t('Failed to fork chat'));
				return;
			}

			const res = await createNewChat(localStorage.token, payload, chat?.folder_id ?? null);
			if (!res?.id) {
				toast.error($i18n.t('Failed to fork chat'));
				return;
			}

			await refreshChatListPageOne(localStorage.token);

			// Detached windows have no open-conversation-tab renderer handler, so the
			// bridge would report found without opening anything — navigate in place there.
			let handled = false;
			const host = (window as any)?.webviewHost;
			if (
				getDetachedWindowMode($page.url.searchParams) === '' &&
				typeof host?.navigateToConversation === 'function'
			) {
				try {
					handled = await host.navigateToConversation(res.id, undefined, { title: forkTitle });
				} catch {
					handled = false;
				}
			}
			if (!handled) {
				await goto(`/c/${res.id}`);
			}
		} catch (e) {
			console.error('forkChat', e);
			toast.error($i18n.t('Failed to fork chat'));
		}
	};

		const continueResponse = async () => {
			if (delegatedSubagentView) return;
			console.log('continueResponse');
			const _chatId = JSON.parse(JSON.stringify(activeChatId));

			if (history.currentId && history.messages[history.currentId].done == true) {
				const responseMessage = history.messages[history.currentId];
				responseMessage.streamStartedAt = Date.now();
				responseMessage.done = false;
				if (forceStoppedMessageIds.delete(responseMessage.id)) {
					composerStreamingStateVersion += 1;
				}
				if (responseMessage.stop_reason === USER_STOP_REASON) {
					delete responseMessage.stop_reason;
				}
				await tick();

			const model = $models
				.filter((m) => m.id === (responseMessage?.selectedModelId ?? responseMessage.model))
				.at(0);

			if (model) {
				await sendMessageSocket(
					model,
					createMessagesList(history, responseMessage.id),
					history,
					responseMessage.id,
					_chatId,
					responseMessage.modelIdx ?? 0 // Use stored model index for per-model reasoning effort
				);
			}
		}
	};

	const mergeResponses = async (messageId, responses, _chatId) => {
		if (delegatedSubagentView) return;
		console.log('mergeResponses', messageId, responses);
		const message = history.messages[messageId];
		const mergedResponse = {
			status: true,
			content: ''
		};
		message.merged = mergedResponse;
		history.messages[messageId] = message;

		try {
			generating = true;
			const [res, controller] = await generateMoACompletion(
				localStorage.token,
				message.model ?? '',
				message.parentId ? history.messages[message.parentId].content : '',
				responses
			);

			if (res && res.ok && res.body && generating) {
				generationController = controller as AbortController;
				const textStream = await createOpenAITextStream(
					res.body,
					Boolean($settings?.splitLargeChunks ?? false)
				);
				for await (const update of textStream) {
					const { value, done, sources, error, usage } = update;
					if (error || done) {
						generating = false;
						generationController = null;
						break;
					}

					if (mergedResponse.content == '' && value == '\n') {
						continue;
					} else {
						mergedResponse.content += value;
						history.messages[messageId] = message;
					}

					if (autoScroll) {
						scrollToBottom();
					}
				}

				await saveChatHandler(_chatId, history);
			} else {
				console.error(res);
			}
		} catch (e) {
			console.error(e);
		}
	};

	const initChatHandler = async (history) => {
		let _chatId = activeChatId;

		if (!$temporaryChatEnabled) {
			const pendingWorkspaceChatId = _chatId;
			chat = await createNewChat(
				localStorage.token,
				{
					id: _chatId,
					title: $i18n.t('New Chat'),
					models: selectedModels,
					system: $settings.system ?? undefined,
					params: params,
					history: history,
					messages: createMessagesList(history, history.currentId),
					tags: [],
					timestamp: Date.now()
				},
				$selectedFolder?.id
			);

			try {
				await movePendingWorkspaceSelection(pendingWorkspaceChatId, chat.id);
			} catch (error) {
				toast.error(error?.message || $i18n.t('Failed to apply selected workspace folder'));
				throw error;
			}

			_chatId = chat.id;
			setActiveChat(_chatId);

			window.history.replaceState(history.state, '', `/c/${_chatId}`);

			await tick();

			await refreshChatListPageOne(localStorage.token);

			selectedFolder.set(null);
		} else {
			_chatId = _chatId || `local:${$socket?.id || uuidv4()}`; // Use socket id for temporary chat
			setActiveChat(_chatId);
		}
		await tick();

		return _chatId;
	};

	const saveChatHandler = async (
		_chatId,
		history,
		{
			modelIdsSnapshot = selectedModelIds,
			reasoningEffortByModelSnapshot = getResolvedReasoningEffortByModelSnapshot(modelIdsSnapshot)
		}: {
			modelIdsSnapshot?: string[] | null | undefined;
			reasoningEffortByModelSnapshot?: Record<string, string>;
		} = {}
	) => {
		if (activeChatId == _chatId) {
			if (!$temporaryChatEnabled) {
				chat = await updateChatById(localStorage.token, _chatId, {
					models: selectedModels,
					history: history,
					messages: createMessagesList(history, history.currentId),
					params: params,
					files: chatFiles,
					// Reviewer workflow: the per-chat decision (locked at first
					// prompt) rides every whole-chat save; the backend merge is
					// key-level, so other writers that omit it can't erase it.
					reviewer_workflow: reviewerWorkflowEnabledLocal
				});
				await refreshChatListPageOne(localStorage.token);

				// Portico: Persist context tokens and per-model reasoning effort after chat save
				persistReasoningEffortSnapshot({
					chatId: _chatId,
					modelIds: modelIdsSnapshot,
					reasoningEffortByModelSnapshot
				});
			}
		}
	};

	const MAX_DRAFT_LENGTH = 5000;
	let saveDraftTimeout: ReturnType<typeof setTimeout> | null = null;

	const saveDraftImmediately = async (draft, chatId = null) => {
		if (saveDraftTimeout) {
			clearTimeout(saveDraftTimeout);
			saveDraftTimeout = null;
		}

		if (draft.prompt !== null && draft.prompt.length < MAX_DRAFT_LENGTH) {
			await sessionStorage.setItem(
				`chat-input${chatId ? `-${chatId}` : ''}`,
				JSON.stringify(draft)
			);
		} else {
			sessionStorage.removeItem(`chat-input${chatId ? `-${chatId}` : ''}`);
		}
	};

	const saveDraft = async (draft, chatId = null) => {
		if (saveDraftTimeout) {
			clearTimeout(saveDraftTimeout);
		}

		if (draft.prompt !== null && draft.prompt.length < MAX_DRAFT_LENGTH) {
			saveDraftTimeout = setTimeout(async () => {
				await sessionStorage.setItem(
					`chat-input${chatId ? `-${chatId}` : ''}`,
					JSON.stringify(draft)
				);
			}, 500);
		} else {
			sessionStorage.removeItem(`chat-input${chatId ? `-${chatId}` : ''}`);
		}
	};

	const clearDraft = async (chatId = null) => {
		if (saveDraftTimeout) {
			clearTimeout(saveDraftTimeout);
		}
		await sessionStorage.removeItem(`chat-input${chatId ? `-${chatId}` : ''}`);
	};

	const archiveChatHandler = async (requestedChatId) => {
		if (!requestedChatId || delegatedSubagentView) {
			return;
		}

		const navigationGenerationAtStart = chatNavigationGeneration;
		const archivedChat = await archiveChatSafely(localStorage.token, requestedChatId).catch(
			(error) => {
				toast.error(`${error}`);
				return null;
			}
		);
		if (archivedChat?.archived !== true) {
			return;
		}

		const [pinnedResult, tagsResult] = await Promise.allSettled([
			getPinnedChatList(localStorage.token),
			getAllTags(localStorage.token),
			refreshChatListPageOne(localStorage.token)
		]);
		if (pinnedResult.status === 'fulfilled') {
			pinnedChats.set(pinnedResult.value);
		}
		if (tagsResult.status === 'fulfilled') {
			allTags.set(tagsResult.value);
		}

		if (
			chatNavigationGeneration === navigationGenerationAtStart &&
			get(chatId) === requestedChatId
		) {
			await goto('/');
			setActiveChat('');
			await tick();
		}
	};

	const moveChatHandler = async (chatId, folderId) => {
		if (chatId && folderId) {
			const res = await updateChatFolderIdById(localStorage.token, chatId, folderId).catch(
				(error) => {
					toast.error(`${error}`);
					return null;
				}
			);

			if (res) {
				await refreshChatListPageOne(localStorage.token);
				await pinnedChats.set(await getPinnedChatList(localStorage.token));

				toast.success($i18n.t('Chat moved successfully'));
			}
		} else {
			toast.error($i18n.t('Failed to move chat'));
		}
	};
</script>

<svelte:head>
	{#if !isTile}
		<title>
			{$settings.showChatTitleInTab !== false && $chatTitle
				? `${$chatTitle.length > 30 ? `${$chatTitle.slice(0, 30)}...` : $chatTitle} • ${$WEBUI_NAME}`
				: `${$WEBUI_NAME}`}
		</title>
	{/if}
</svelte:head>

{#if !isTile}
	<audio id="audioElement" src="" style="display: none;"></audio>
{/if}

<EventConfirmDialog
	bind:show={showEventConfirmation}
	title={eventConfirmationTitle}
	message={eventConfirmationMessage}
	input={eventConfirmationInput}
	inputPlaceholder={eventConfirmationInputPlaceholder}
	inputValue={eventConfirmationInputValue}
	on:confirm={(e) => {
		if (e.detail) {
			eventCallback(e.detail);
		} else {
			eventCallback(true);
		}
	}}
	on:cancel={() => {
		eventCallback(false);
	}}
/>

<!-- Sizing note: Chat always mounts inside MultiChatContainer now, which owns
     the viewport height and the sidebar width compensation — panes and the
     single-chat case alike just fill their slot. -->
<div
	class="portico-chat-canvas h-full max-h-full transition-width duration-200 ease-in-out w-full max-w-full flex flex-col"
	id="chat-container"
	data-chat-id={activeChatId || chatIdProp || undefined}
	data-chat-load-state={loading ? 'loading' : chatFirstPaintReady ? 'ready' : 'painting'}
	data-detached-subagent-state={delegatedSubagentView ? detachedSubagentStatus : undefined}
>
	{#if delegatedSubagentView && loading}
		<div
			class="relative z-10 flex h-full w-full items-center justify-center px-6 text-center"
			data-detached-subagent-state={detachedSubagentStatus}
		>
			<div
				class="max-w-md rounded-lg border border-gray-200 bg-white/90 p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900/90"
			>
				<div
					class="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-blue-500 dark:border-gray-700 dark:border-t-blue-400"
				></div>
				<div class="text-base font-semibold text-gray-900 dark:text-gray-100">
					Opening subagent
				</div>
				<div class="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">
					{detachedSubagentStatusMessage}
				</div>
			</div>
		</div>
	{:else if !loading}
		<div in:fade={{ duration: 50 }} class="w-full h-full flex flex-col relative">
			{#if $selectedFolder && $selectedFolder?.meta?.background_image_url}
				<div
					class="absolute top-0 left-0 w-full h-full bg-cover bg-center bg-no-repeat"
					style="background-image: url({$selectedFolder?.meta?.background_image_url})  "
				/>

				<div
					class="absolute top-0 left-0 w-full h-full bg-linear-to-t from-white to-white/85 dark:from-gray-900 dark:to-gray-900/90 z-0"
				/>
			{:else if $settings?.backgroundImageUrl ?? $config?.license_metadata?.background_image_url ?? null}
				<div
					class="absolute top-0 left-0 w-full h-full bg-cover bg-center bg-no-repeat"
					style="background-image: url({$settings?.backgroundImageUrl ??
						$config?.license_metadata?.background_image_url})  "
				/>

				<div
					class="absolute top-0 left-0 w-full h-full bg-linear-to-t from-white to-white/85 dark:from-gray-900 dark:to-gray-900/90 z-0"
				/>
			{/if}

			<!-- PORTICO PATCH (landing starfield): dark-mode-only cosmic backdrop;
			     the component gates on isDarkMode internally and CSS owns the
			     fade-in. z-0 + pointer-events-none behind the z-10 scroller,
			     mirroring the background-image layers above. -->
			{#if showLandingStarfield}
				<LandingStarfield />
			{/if}

			{#if rateLimitOverlayActive}
				<div
					class="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/15 backdrop-blur-[2px]"
				>
					<div
						class="w-[360px] max-w-[calc(100%-40px)] rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-lg"
					>
						<div
							class="mx-auto mb-4 h-11 w-11 animate-spin rounded-full border-4 border-slate-200 border-t-rose-300"
						></div>
						<div class="text-lg font-semibold text-slate-800">
							Uh oh... we're getting rate limited!
						</div>
						<div class="mt-1 text-sm text-slate-600">We're having too much fun!</div>
						<div class="mt-3 text-sm text-slate-700">
							{#if rateLimitOverlayPhase === 'retrying'}
								Retrying now...
							{:else if rateLimitOverlayPhase === 'canceling'}
								Canceling retry...
							{:else}
								Retrying in {rateLimitOverlaySeconds}s
							{/if}
						</div>
						{#if rateLimitOverlayAttempt > 0}
							<div class="mt-1 text-xs text-slate-500">
								Attempt {rateLimitOverlayAttempt}
								{#if rateLimitOverlayMaxAttempts > 0}
									of {rateLimitOverlayMaxAttempts}
								{/if}
							</div>
						{/if}
						<button
							class="mt-4 rounded-full bg-rose-500 px-4 py-2 text-xs font-semibold text-white shadow hover:bg-rose-500/90 disabled:cursor-not-allowed disabled:opacity-60"
							disabled={rateLimitOverlayCanceling}
							on:click={cancelRateLimitRetry}
						>
							{rateLimitOverlayCanceling ? 'Canceling...' : 'Cancel retry'}
						</button>
					</div>
				</div>
			{/if}

			{#if detachedSubagentLoadError}
				<div
					class="relative z-10 flex h-full w-full items-center justify-center px-6 text-center"
					data-detached-subagent-state={detachedSubagentStatus}
				>
					<div
						class="max-w-md rounded-lg border border-gray-200 bg-white/90 p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900/90"
					>
						<div class="text-base font-semibold text-gray-900 dark:text-gray-100">
							Subagent details unavailable
						</div>
						<div class="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">
							{detachedSubagentStatusMessage}
						</div>
					</div>
				</div>
			{:else if paneLoadError}
				<div class="relative z-10 flex h-full w-full items-center justify-center px-6 text-center">
					<div
						class="max-w-md rounded-lg border border-gray-200 bg-white/90 p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900/90"
					>
						<div class="text-base font-semibold text-gray-900 dark:text-gray-100">
							{$i18n.t('This chat could not be loaded')}
						</div>
						<div class="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">
							{$i18n.t('The tiled chat failed to load. It may have been deleted.')}
						</div>
					</div>
				</div>
			{:else}
				<PaneGroup direction="horizontal" class="w-full h-full">
				<Pane defaultSize={50} minSize={30} class="h-full flex relative max-w-full flex-col">
					{#if !isTile}
					<Navbar
						bind:this={navbarElement}
						chat={{
							id: activeChatId,
							chat: {
								title: $chatTitle,
								models: selectedModels,
								system: $settings.system ?? undefined,
								params: params,
								history: history,
								timestamp: Date.now()
							}
						}}
						{history}
						title={$chatTitle}
						bind:selectedModels
						shareEnabled={!!history.currentId}
						showModelSelector={!delegatedSubagentView}
						readOnlyView={delegatedSubagentView}
						{initNewChat}
						{archiveChatHandler}
						{moveChatHandler}
						onSaveTempChat={async () => {
							try {
								if (!history?.currentId || !Object.keys(history.messages).length) {
									toast.error($i18n.t('No conversation to save'));
									return;
								}
								const messages = createMessagesList(history, history.currentId);
								const title =
									messages.find((m) => m.role === 'user')?.content ?? $i18n.t('New Chat');

								const savedChat = await createNewChat(
									localStorage.token,
									{
										id: uuidv4(),
										title: title.length > 50 ? `${title.slice(0, 50)}...` : title,
										models: selectedModels,
										history: history,
										messages: messages,
										timestamp: Date.now()
									},
									null
								);

								if (savedChat) {
									temporaryChatEnabled.set(false);
									setActiveChat(savedChat.id);
									await refreshChatListPageOne(localStorage.token);

									await goto(`/c/${savedChat.id}`);
									toast.success($i18n.t('Conversation saved successfully'));
								}
							} catch (error) {
								console.error('Error saving conversation:', error);
								toast.error($i18n.t('Failed to save conversation'));
							}
						}}
					/>
					{/if}

					<div class="relative flex flex-col flex-auto z-10 w-full @container overflow-auto">
						{#if !showLandingPlaceholder}
							<!--
								PORTICO PATCH: data-portico-chat-root marks the scoped root for the
								shell-side Custom Highlight API local-find controller (Cmd+G).
								See electron-app/src/services/owui-local-find-page.js. Without
								this attribute, the controller would scan the whole document and
								re-introduce sidebar/nav leakage (test plan E-10).
							-->
							<div
									class=" pb-2.5 flex flex-col justify-between w-full flex-auto overflow-auto h-0 max-w-full z-10"
								id="messages-container"
								data-portico-chat-root="true"
								bind:this={messagesContainerElement}
								on:wheel={handleMessagesWheel}
								on:scroll={handleMessagesScroll}
							>
								<div class=" h-full w-full flex flex-col" bind:this={messagesContentElement}>
									<Messages
										chatId={activeChatId}
										bind:history
										bind:autoScroll
										bind:prompt
										setInputText={(text) => {
											messageInput?.setText(text);
										}}
										{selectedModels}
										{reasoningEffortByModel}
										richContentReady={chatRichContentReady}
										{atSelectedModel}
										{sendMessage}
										{showMessage}
										{submitMessage}
										{continueResponse}
										{regenerateResponse}
										{forkChat}
										{mergeResponses}
										{stopResponse}
										{chatActionHandler}
										{addMessages}
										readOnly={delegatedSubagentView}
										topPadding={true}
										bottomPadding={files.length > 0}
										debugMarkersAfterMessageId={debugModeEnabled ? debugMarkersAfterMessageId : {}}
										debugMarkersAfterToolBlockByMessageId={debugModeEnabled
											? debugMarkersAfterToolBlockByMessageId
											: {}}
										debugBackgroundMarkers={debugModeEnabled ? debugBackgroundMarkers : []}
										{openDebugRequestModal}
										{onSelect}
									/>
								</div>
							</div>

							{#if !isTile}
							<!-- In a tiled view the primary's composer node re-parents into
							     the container's shared bottom bar (portalTo); bindings and
							     handlers survive the DOM move. Tiles render no composer. -->
							<div class=" pb-0.5 z-10" use:portalTo={composerPortalTarget}>
								<MessageInput
									bind:this={messageInput}
									chatId={activeChatId || chatIdProp}
									ensureChatId={ensureComposerChatId}
									hasConversation={Boolean(history?.currentId)}
									getAutocompleteMessages={getAutocompleteContextMessages}
									bind:selectedModels={composerSelectedModels}
									bind:files
									bind:prompt
									bind:autoScroll
									bind:selectedToolIds
									bind:selectedFilterIds
									bind:imageGenerationEnabled
									bind:codeInterpreterEnabled
									bind:webSearchEnabled
									bind:atSelectedModel
									bind:showCommands
									reasoningEffortByModel={composerViewState.reasoningEffortByModel}
									reasoningEffortReady={composerViewState.reasoningEffortReady}
									onReasoningEffortSelect={handleComposerReasoningEffortSelect}
									fastModeEnabled={composerViewState.fastModeEnabled}
									onFastModeToggle={handleComposerFastModeToggle}
									reviewerWorkflowEnabled={reviewerWorkflowEnabledLocal}
									{reviewerWorkflowLocked}
									onReviewerWorkflowToggle={handleReviewerWorkflowToggle}
									contextTokens={composerViewState.contextTokens}
									aggregateCost={composerViewState.costMetrics.cost}
									aggregateCostWithoutCache={composerViewState.costMetrics.costWithoutCache}
									aggregateCacheSavings={composerViewState.costMetrics.cacheSavings}
									aggregateSavingsRate={composerViewState.costMetrics.savingsRate}
									aggregateCachedTokens={composerViewState.costMetrics.cachedTokens}
									aggregateCacheReadTokens={composerViewState.costMetrics.cacheReadTokens}
									aggregateCacheWriteTokens={composerViewState.costMetrics.cacheWriteTokens}
									toolServers={$toolServers}
									activeCapabilities={composerViewState.activeCapabilities}
									pendingSteer={composerPendingSteer}
									{pendingToolConfirmations}
									onToolConfirmationDecision={handleToolConfirmationChipDecision}
									queuedPrompts={composerQueuedPrompts}
									isStreaming={composerIsStreaming}
									crossPaneTargetLabel={crossPaneTarget?.displayName ??
										(composerPortalTarget ? ORCHESTRATOR_DISPLAY_NAME : null)}
									pendingWorkEditMode={editingPendingWork?.kind ?? 'none'}
									readOnlyMode={delegatedSubagentView}
									{generating}
									{stopResponse}
									onSubmitPendingSteer={submitPendingSteerFromComposer}
									onSubmitQueuedPrompt={submitQueuedPromptFromComposer}
									onRestorePendingSteer={replaceComposerWithPendingSteer}
									onRestoreQueuedPrompt={rotateQueuedPromptIntoComposer}
									onCancelPendingWorkEdit={cancelPendingWorkEdit}
									onCancelPendingSteer={cancelPendingSteerItem}
									onCancelQueuedPrompt={cancelQueuedPromptItem}
									{createMessagePair}
									{onUpload}
									onChange={(data) => {
										if (!$temporaryChatEnabled) {
											// While a tile is focused the payload carries the
											// TARGET's muxed effort/fast-mode — keep the
											// primary's own values in the primary's draft.
											saveDraft(
												buildPrimaryDraftPayload({
													data,
													crossPaneActive: Boolean(crossPaneTarget),
													primaryReasoningEffortByModel: reasoningEffortByModel,
													primaryFastModeEnabled: fastModeEnabled
												}),
												activeChatId
											);
										}
									}}
									on:submit={async (e) => {
										clearDraft();
										const normalizedPrompt = normalizeSubmitPrompt(e.detail);
										if (normalizedPrompt || files.length > 0) {
											await tick();

											if (crossPaneTarget) {
												// Never augment cross-pane — a focused tile's chat
												// already had its first prompt.
												await dispatchCrossPaneMessage(normalizedPrompt);
											} else {
												// Reviewer workflow: augments ONLY the chat's first
												// prompt and locks the decision at first send.
												submitPrompt(consumeReviewerWorkflowArming(normalizedPrompt));
											}
										}
									}}
								/>

								<div
									class="absolute bottom-1 text-xs text-gray-500 text-center line-clamp-1 right-0 left-0"
								>
									<!-- {$i18n.t('LLMs can make mistakes. Verify important information.')} -->
								</div>
							</div>
							{/if}
						{:else}
							<div class="flex items-center h-full">
								<Placeholder
									chatId={activeChatId || chatIdProp}
									ensureChatId={ensureComposerChatId}
									{history}
									bind:selectedModels
									bind:messageInput
									bind:files
									bind:prompt
									bind:autoScroll
									bind:selectedToolIds
									bind:selectedFilterIds
									bind:imageGenerationEnabled
									bind:codeInterpreterEnabled
									bind:webSearchEnabled
									bind:atSelectedModel
									bind:showCommands
									reasoningEffortByModel={reasoningEffortByModel}
									reasoningEffortReady={reasoningEffortReady}
									onReasoningEffortSelect={handleReasoningEffortSelection}
									{fastModeEnabled}
									onFastModeToggle={handleFastModeToggle}
									reviewerWorkflowEnabled={reviewerWorkflowEnabledLocal}
									{reviewerWorkflowLocked}
									onReviewerWorkflowToggle={handleReviewerWorkflowToggle}
									reviewerWorkflowIntroVisible={reviewerCtaVisible}
									reviewerWorkflowIntroRemaining={reviewerCtaRemaining}
									onReviewerWorkflowIntroDismiss={dismissReviewerCta}
									toolServers={$toolServers}
									{stopResponse}
									{createMessagePair}
									{onSelect}
									{onUpload}
									onChange={(data) => {
										if (!$temporaryChatEnabled) {
											saveDraft(data);
										}
									}}
									on:submit={async (e) => {
										clearDraft();
										const normalizedPrompt = normalizeSubmitPrompt(e.detail);
										if (normalizedPrompt || files.length > 0) {
											await tick();
											submitPrompt(consumeReviewerWorkflowArming(normalizedPrompt));
										}
									}}
								/>
							</div>
						{/if}
					</div>
				</Pane>

				{#if !isTile}
				<ChatControls
					bind:this={controlPaneComponent}
					bind:history
					bind:chatFiles
					bind:params
					bind:files
					bind:pane={controlPane}
					chatId={activeChatId}
					modelId={selectedModelIds?.at(0) ?? null}
					models={selectedModelIds.reduce((a, e, i, arr) => {
						const model = $models.find((m) => m.id === e);
						if (model) {
							return [...a, model];
						}
						return a;
					}, [])}
					{submitPrompt}
					{stopResponse}
					{showMessage}
					{eventTarget}
				/>
				{/if}
				</PaneGroup>
			{/if}
		</div>
	{:else if loading}
		<div class=" flex items-center justify-center h-full w-full">
			<div class="m-auto">
				<Spinner className="size-5" />
			</div>
		</div>
	{/if}
</div>

<style>
	::-webkit-scrollbar {
		height: 0.5rem;
		width: 0.5rem;
	}
</style>
