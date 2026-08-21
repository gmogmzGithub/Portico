<!--
  PORTICO PATCHED FILE

  Changes from original Open WebUI MessageInput.svelte:
  1. Added reasoning effort pill with bits-ui Dropdown (sparkles icon + current level label)
     - Wrapped in Tooltip showing "Reasoning Effort" on hover
  2. Added a consolidated usage widget with a context meter, percentage, and spend
     - One hover surface contains context, cache, cost, MCP, and skill details
     - Color coding: blue (<50%), yellow (50-80%), red (≥80%)
  3. Removed integrations menu (grid icon)
  4. Removed tools icon (wrench with count)
  5. Added latest-turn context usage and aggregate chat cost/cache details

  See: src/scripts/generate-model-config.js for model capability generation
-->
<script lang="ts">
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';

	import { toast } from 'svelte-sonner';

	import { v4 as uuidv4 } from 'uuid';
	import { createPicker, getAuthToken } from '$lib/utils/google-drive-picker';
	import { badgeStyleVars } from '$lib/utils/displayNameBadge.mjs';
	import { portalTo } from '$lib/utils/portalAction';
	import { pickAndDownloadFile } from '$lib/utils/onedrive-file-picker';

	import { onMount, tick, getContext, createEventDispatcher, onDestroy } from 'svelte';
	import { browser } from '$app/environment';

	// PORTICO PATCH: Import bits-ui Dropdown for consistent menu styling
	import { DropdownMenu } from 'bits-ui';
	import Dropdown from '../common/Dropdown.svelte';
	import { flyAndScale } from '$lib/utils/transitions';
	const dispatch = createEventDispatcher();

	import {
		type Model,
		mobile,
		settings,
		models,
		config,
		showCallOverlay,
		tools,
		toolServers,
		user as _user,
		showControls,
		TTSWorker,
		temporaryChatEnabled
	} from '$lib/stores';

	import {
		convertHeicToJpeg,
		compressImage,
		extractContentFromFile,
		extractCurlyBraceWords,
		extractInputVariables,
		getAge,
		getCurrentDateTime,
		getFormattedDate,
		getFormattedTime,
		getUserPosition,
		getUserTimezone,
		getWeekday
	} from '$lib/utils';
	import { uploadFile } from '$lib/apis/files';
	import { generateAutoCompletion } from '$lib/apis';
	import { deleteFileById } from '$lib/apis/files';
	import { getSessionUser } from '$lib/apis/auths';
	import { getTools } from '$lib/apis/tools';

	import { WEBUI_BASE_URL, WEBUI_API_BASE_URL, PASTED_TEXT_CHARACTER_LIMIT } from '$lib/constants';
	import { getModelLogoSources, usesCelestialModelLogo } from '$lib/utils/modelBranding';

	import InputMenu from './MessageInput/InputMenu.svelte';
	import ModelSelector from './ModelSelector.svelte';
	import ReasoningEffortControl from './MessageInput/ReasoningEffortControl.svelte';
	import FastModeToggle from './MessageInput/FastModeToggle.svelte';
	import ReviewerWorkflowToggle from './MessageInput/ReviewerWorkflowToggle.svelte';
	import ComposerMetrics from './MessageInput/ComposerMetrics.svelte';
	import VoiceRecording from './MessageInput/VoiceRecording.svelte';
	import FilesOverlay from './MessageInput/FilesOverlay.svelte';
	// PORTICO PATCH (N-012): per-action MCP tool confirmation chip rendered
	// above the composer alongside the Pending Steer chip.
	import ToolConfirmationChip from './MessageInput/ToolConfirmationChip.svelte';
	import ChipClusterGroup from './MessageInput/ChipClusterGroup.svelte';
	import ToolServersModal from './ToolServersModal.svelte';

	import RichTextInput from '../common/RichTextInput.svelte';
	import Tooltip from '../common/Tooltip.svelte';

	// PORTICO PATCH: Import ActiveCapabilities for real-time display
	import ActiveCapabilities from './ActiveCapabilities.svelte';
	import type { ChatCapabilities } from '$lib/apis/chatCapabilities';
	import type { PendingWorkItem } from '$lib/apis/chatPendingWork';
	import FileItem from '../common/FileItem.svelte';
	import Image from '../common/Image.svelte';

	import XMark from '../icons/XMark.svelte';
	import Headphone from '../icons/Headphone.svelte';
	import GlobeAlt from '../icons/GlobeAlt.svelte';
	import Photo from '../icons/Photo.svelte';
	import Wrench from '../icons/Wrench.svelte';
	import CommandLine from '../icons/CommandLine.svelte';
	import Sparkles from '../icons/Sparkles.svelte';

	import InputVariablesModal from './MessageInput/InputVariablesModal.svelte';
	import Voice from '../icons/Voice.svelte';
	import Terminal from '../icons/Terminal.svelte';
	import IntegrationsMenu from './MessageInput/IntegrationsMenu.svelte';
	import Component from '../icons/Component.svelte';
	import FolderOpen from '../icons/FolderOpen.svelte';

	import { KokoroWorker } from '$lib/workers/KokoroWorker';

	import { getSuggestionRenderer } from '../common/RichTextInput/suggestions';
	import CommandSuggestionList from './MessageInput/CommandSuggestionList.svelte';
	import Knobs from '../icons/Knobs.svelte';
	import ValvesModal from '../workspace/common/ValvesModal.svelte';
	// PORTICO PATCH: Import model capabilities for reasoning effort and context tracking
	import {
		getReasoningEffortOptions,
		type ReasoningEffortOption
	} from '$lib/config/model-capabilities';
	import { resolveModelMaxContextTokens } from '$lib/utils/model-context-window';
	import {
		resolveReasoningEffortByModelEntry
	} from '$lib/utils/chatReasoningState';
	// PORTICO PATCH (fast mode): GPT detection for the lightning toggle
	import { isGptFastModeModel } from '$lib/utils/chatFastModeState';
	import {
		getPendingWorkPreviewText,
		getPendingWorkShortcutKeycaps,
		type PendingWorkEditMode,
		resolveComposerHotkeyAction
	} from '$lib/utils/pendingChatWork';

	const i18n = getContext('i18n');

	export let onUpload: Function = (e) => {};
	export let onChange: Function = () => {};

	export let createMessagePair: Function;
	export let stopResponse: Function;

	export let autoScroll = false;
	export let generating = false;

	export let atSelectedModel: Model | undefined = undefined;
	export let selectedModels: [''];

	let selectedModelIds = [];
	$: selectedModelIds = atSelectedModel !== undefined ? [atSelectedModel.id] : selectedModels;

	export let hasConversation = false;
	export let getAutocompleteMessages: Function = () => null;

	export let prompt = '';
	export let files = [];

	export let selectedToolIds = [];
	export let selectedFilterIds = [];

	export let imageGenerationEnabled = false;
	export let webSearchEnabled = false;
	export let codeInterpreterEnabled = false;

	// PORTICO PATCH: Reasoning effort and context tracking props
	// Per-chat reasoning effort map keyed by selected model index ('0', '1', ...).
	export let reasoningEffortByModel: Record<string, string> = {};
	export let reasoningEffortReady = false;
	// PORTICO PATCH (fast mode): per-chat lightning toggle; state owned by
	// Chat.svelte, persisted via chat-state, applies to GPT models only.
	export let fastModeEnabled = false;
	export let onFastModeToggle: Function = () => {};
	// PORTICO (reviewer workflow): per-chat toggle state from the owning Chat —
	// armed pre-first-prompt, locked read-only afterwards. The intro CTA only
	// renders when the parent says so (landing composer, impression budget).
	export let reviewerWorkflowEnabled = false;
	export let reviewerWorkflowLocked = false;
	export let onReviewerWorkflowToggle: Function = () => {};
	export let reviewerWorkflowIntroVisible = false;
	export let reviewerWorkflowIntroRemaining = 0;
	export let onReviewerWorkflowIntroDismiss: Function = () => {};
	// Increments per committed send: keys the ignition layer so the pulse
	// replays on every prompt while fast mode is on.
	export let contextTokens = 0;
	export let aggregateCost = 0;
	export let aggregateCostWithoutCache = 0;
	export let aggregateCacheSavings = 0;
	export let aggregateSavingsRate = 0;
	export let aggregateCachedTokens = 0;
	export let aggregateCacheReadTokens = 0;
	export let aggregateCacheWriteTokens = 0;

	// PORTICO PATCH: Active capabilities for real-time display
	export let activeCapabilities: ChatCapabilities = { tools: [], skills: [] };
	export let readOnlyMode = false;
	// Multi-chat tiling: name of the focused peer pane the composer currently
	// dispatches to (null when messages go to this chat itself).
	export let crossPaneTargetLabel: string | null = null;
	// Scroll-button dock target: the input container itself, so the buttons
	// sit exactly at its right edge, vertically centered (the outer column is
	// wider than the box, so column-relative offsets land far from the
	// visible edge).
	let messageInputContainerElement: HTMLElement | null = null;
	export let pendingSteer: PendingWorkItem | null = null;
	// PORTICO PATCH (N-012): chat-scoped MCP tool-confirmation chips. One entry
	// per pending destructive call; renders stacked above the Pending Steer
	// block. State is owned by Chat.svelte (re-projected from
	// `chat:tool_confirmation` events); the chip itself is presentational and
	// the gate's natural-language resolver remains the source of truth for
	// what counts as approval.
	export let pendingToolConfirmations: Array<{
		hash: string;
		tool_name: string;
		mcp: string;
		summary: string;
		args_preview: Record<string, unknown>;
		state: 'pending' | 'approved' | 'cancelled' | 'modify-submitted';
		modify_payload?: string;
	}> = [];
	// PORTICO PATCH (N-012): chat id is required by ToolConfirmationChip so it
	// can call /api/v1/utils/chip/resolve with the correct chat scope. The
	// backend verifies ownership before honouring the click.
	export let chatId: string = '';
	export let onToolConfirmationDecision: (event: CustomEvent) => void = () => {};
	export let queuedPrompts: PendingWorkItem[] = [];
	export let isStreaming = false;
	export let pendingWorkEditMode: PendingWorkEditMode = 'none';
	export let onSubmitPendingSteer: Function = async () => false;
	export let onSubmitQueuedPrompt: Function = async () => false;
	export let onRestorePendingSteer: Function = async () => false;
	export let onRestoreQueuedPrompt: Function = async (_direction = 'previous') => false;
	export let onCancelPendingWorkEdit: Function = async () => false;
	export let onCancelPendingSteer: Function = async () => {};
	export let onCancelQueuedPrompt: Function = async (_itemId: string) => {};
	export let onReasoningEffortSelect: Function = () => {};
	export let ensureChatId: Function | null = null;

	import { isNativeInputInteractionLocked } from '$lib/utils/nativeInputLock';

	type NativeInputPresentationFlow = {
		kind: 'user_question' | 'sensitive_info' | 'chat_workspace_consent' | 'marketplace_publish';
		flow_id: string;
		chat_id: string | null;
		item_count: number;
		presentation: 'hidden';
	};
	let nativeInputPresentationFlows: NativeInputPresentationFlow[] = [];
	let reopeningNativeInput = false;
	// marketplace_publish flows carry no chat id (the publish tool call is not
	// chat-scoped), so their waiting pill shows in whichever chat is active.
	$: hiddenNativeInputFlow =
		nativeInputPresentationFlows.find(
			(flow) =>
				flow.presentation === 'hidden' &&
				(flow.chat_id === chatId || flow.kind === 'marketplace_publish')
		) ?? null;
	// marketplace_publish is not chat-scoped: its pill is informational in
	// whichever chat is active, but it must not inert the composer the way the
	// chat-blocking flows (questions, sensitive info, consent) do.
	// PORTICO-348: the locking rule lives in nativeInputLock.js so it is executable
	// in tests instead of pinned by a source-text regex.
	$: nativeInputInteractionLocked = isNativeInputInteractionLocked(
		nativeInputPresentationFlows,
		chatId
	);
	// Hidden marketplace approvals park as a BATCH (the modal hides every
	// member flow), so the pill badge shows the real pending count instead of
	// the oldest flow's item_count (always 1 for marketplace flows).
	$: marketplaceApprovalCount = nativeInputPresentationFlows.filter(
		(flow) => flow.kind === 'marketplace_publish'
	).length;
	$: nativeInputAttentionTitle =
		hiddenNativeInputFlow?.kind === 'sensitive_info'
			? $i18n.t('Sensitive information is waiting')
			: hiddenNativeInputFlow?.kind === 'chat_workspace_consent'
				? $i18n.t('Workspace permission is waiting')
				: hiddenNativeInputFlow?.kind === 'marketplace_publish'
					? marketplaceApprovalCount > 1
						? $i18n.t('Marketplace approvals are waiting')
						: $i18n.t('Marketplace publish approval is waiting')
					: $i18n.t('Questions waiting for your response');
	$: nativeInputAttentionDescription =
		hiddenNativeInputFlow?.kind === 'sensitive_info'
			? $i18n.t('Return to the secure prompt to continue this chat')
			: hiddenNativeInputFlow?.kind === 'chat_workspace_consent'
				? $i18n.t('Return to review folder access and continue this chat')
				: hiddenNativeInputFlow?.kind === 'marketplace_publish'
					? marketplaceApprovalCount > 1
						? $i18n.t('Return to review the publish requests and continue this chat')
						: $i18n.t('Return to review the publish request and continue this chat')
					: $i18n.t('Return to the questions to continue this chat');

	const applyNativeInputPresentationSnapshot = (snapshot: any) => {
		nativeInputPresentationFlows = Array.isArray(snapshot?.flows)
			? snapshot.flows.filter(
					(flow: any) =>
						[
							'user_question',
							'sensitive_info',
							'chat_workspace_consent',
							'marketplace_publish'
						].includes(flow?.kind) &&
						typeof flow?.flow_id === 'string' &&
						(typeof flow?.chat_id === 'string' || flow?.kind === 'marketplace_publish') &&
						// PORTICO-348: inline questions are never "hidden"; keep them so the
						// composer can lock while one is pending in this chat.
						(flow?.presentation === 'hidden' || flow?.kind === 'user_question')
				)
			: [];
	};

	const handleNativeInputPresentationSnapshot = (event: CustomEvent) => {
		applyNativeInputPresentationSnapshot(event.detail);
	};

	const reopenHiddenNativeInput = async () => {
		if (!hiddenNativeInputFlow || reopeningNativeInput) return;
		const hostApi = (window as any)?.webviewHost;
		if (typeof hostApi?.reopenNativeInput !== 'function') return;

		reopeningNativeInput = true;
		try {
			applyNativeInputPresentationSnapshot(
				await hostApi.reopenNativeInput(
					hiddenNativeInputFlow.kind,
					hiddenNativeInputFlow.flow_id,
					chatId
				)
			);
		} catch (error) {
			console.error('[MessageInput] Failed to reopen native-input modal:', error);
			toast.error($i18n.t('Could not reopen the request. Please try again.'));
		} finally {
			reopeningNativeInput = false;
		}
	};

	// PORTICO PATCH: Artifacts for this chat (updated via event from Electron)
	let artifacts: { artifact_id: string; name: string; current_version: number }[] = [];
	type ChatWorkspaceSelection = {
		source?: string;
		isCustom?: boolean;
		isUserSelectedCustom?: boolean;
		hostPath?: string;
		canonicalPath?: string;
		displayPath?: string;
		inheritedWorkspace?: boolean;
		inheritedFromChatId?: string;
		rootParentChatId?: string;
	};
	type WorkspaceOperation = 'picking' | 'applying-selection' | 'clearing' | null;
	let workspaceSelection: ChatWorkspaceSelection | null = null;
	let workspaceSelectionChatId = '';
	let workspaceSelectionRequestGeneration = 0;
	let workspaceOperation: WorkspaceOperation = null;
	let workspaceOpenInProgress = false;
	$: selectedWorkspaceDisplayPath = workspaceSelection?.isUserSelectedCustom
		? workspaceSelection?.displayPath || workspaceSelection?.hostPath || ''
		: '';
	$: readOnlyWorkspaceBadgeLabel =
		readOnlyMode && workspaceSelection?.isUserSelectedCustom
			? workspaceSelection.displayPath || workspaceSelection.hostPath || ''
			: '';
	$: readOnlyWorkspaceTooltip =
		readOnlyMode && workspaceSelection
			? workspaceSelection.hostPath || readOnlyWorkspaceBadgeLabel
			: '';
	$: workspaceBusy = workspaceOperation !== null;
	$: workspaceSelectionApplying =
		workspaceOperation === 'applying-selection' || workspaceOperation === 'clearing';

	function getWorkspaceHostApi() {
		return (window as any)?.webviewHost;
	}

	async function getWorkspaceChatId() {
		const currentChatId = String(chatId || '').trim();
		if (currentChatId) {
			return currentChatId;
		}
		if (typeof ensureChatId !== 'function') {
			return '';
		}
		return String((await ensureChatId()) || '').trim();
	}

	async function loadChatWorkspaceSelection() {
		const currentChatId = String(chatId || '').trim();
		const requestGeneration = ++workspaceSelectionRequestGeneration;
		workspaceSelection = null;
		workspaceSelectionChatId = currentChatId;
		if (!browser || !currentChatId) {
			return;
		}

		const hostApi = getWorkspaceHostApi();
		if (!hostApi?.getChatWorkspaceSelection) {
			return;
		}

		try {
			const result = await hostApi.getChatWorkspaceSelection(currentChatId);
			if (
				requestGeneration !== workspaceSelectionRequestGeneration ||
				String(chatId || '').trim() !== currentChatId ||
				workspaceSelectionChatId !== currentChatId
			) {
				return;
			}
			if (result?.success) {
				workspaceSelection = result.selection;
				void reconcileChatWorkspaceVms(currentChatId, {
					silent: true,
					requestGeneration
				});
			} else if (result?.error) {
				console.warn('[MessageInput] Failed to load chat workspace selection:', result.error);
			}
		} catch (error) {
			console.warn('[MessageInput] Failed to load chat workspace selection:', error);
		}
	}

	async function reconcileChatWorkspaceVms(
		currentChatId: string,
		{
			silent = false,
			requestGeneration = workspaceSelectionRequestGeneration
		}: { silent?: boolean; requestGeneration?: number } = {}
	) {
		const hostApi = getWorkspaceHostApi();
		if (!currentChatId || !hostApi?.reconcileChatWorkspaceVms) {
			return;
		}

		try {
			const result = await hostApi.reconcileChatWorkspaceVms(currentChatId);
			if (!result?.success) {
				throw new Error(result?.error || 'Failed to apply selected workspace folder');
			}
			if (
				requestGeneration === workspaceSelectionRequestGeneration &&
				String(chatId || '').trim() === currentChatId &&
				workspaceSelectionChatId === currentChatId &&
				result.selection
			) {
				workspaceSelection = result.selection;
			}
		} catch (error) {
			if (silent) {
				console.warn('[MessageInput] Failed to reconcile chat workspace VMs:', error);
				return;
			}
			toast.error(error?.message || $i18n.t('Failed to apply selected workspace folder'));
		}
	}

	async function selectChatWorkspaceFolder() {
		const currentChatId = await getWorkspaceChatId();
		const hostApi = getWorkspaceHostApi();
		if (
			!currentChatId ||
			!hostApi?.chooseChatWorkspaceFolder ||
			!hostApi?.selectChatWorkspaceFolder ||
			workspaceBusy
		) {
			return;
		}

		const previousSelection = workspaceSelection;
		const previousSelectionChatId = workspaceSelectionChatId;
		let appliedOptimisticSelection = false;
		const requestGeneration = ++workspaceSelectionRequestGeneration;
		workspaceSelectionChatId = currentChatId;
		workspaceOperation = 'picking';
		try {
			const chooseResult = await hostApi.chooseChatWorkspaceFolder(currentChatId);
			if (chooseResult?.canceled) {
				return;
			}
			if (!chooseResult?.success || !chooseResult.selection?.hostPath) {
				throw new Error(chooseResult?.error || 'Failed to select workspace folder');
			}
			const activeChatId = String(chatId || '').trim();
			if (
				requestGeneration !== workspaceSelectionRequestGeneration ||
				(activeChatId && activeChatId !== currentChatId) ||
				workspaceSelectionChatId !== currentChatId
			) {
				return;
			}

			workspaceSelection = chooseResult.selection;
			workspaceSelectionChatId = currentChatId;
			appliedOptimisticSelection = true;
			workspaceOperation = 'applying-selection';

			const result = await hostApi.selectChatWorkspaceFolder(
				currentChatId,
				chooseResult.selection.hostPath
			);
			if (!result?.success) {
				throw new Error(result?.error || 'Failed to apply selected workspace folder');
			}
			if (
				requestGeneration !== workspaceSelectionRequestGeneration ||
				String(chatId || '').trim() !== currentChatId
			) {
				return;
			}
			workspaceSelection = result.selection;
			workspaceSelectionChatId = currentChatId;
			toast.success($i18n.t('Workspace folder updated'));
		} catch (error) {
			if (
				appliedOptimisticSelection &&
				requestGeneration === workspaceSelectionRequestGeneration &&
				String(chatId || '').trim() === currentChatId
			) {
				workspaceSelection = previousSelection;
				workspaceSelectionChatId = previousSelectionChatId;
			}
			toast.error(error?.message || $i18n.t('Failed to select workspace folder'));
		} finally {
			workspaceOperation = null;
		}
	}

	async function clearChatWorkspaceFolder() {
		const currentChatId = await getWorkspaceChatId();
		const hostApi = getWorkspaceHostApi();
		if (!currentChatId || !hostApi?.clearChatWorkspaceFolder || workspaceBusy) {
			return;
		}

		const previousSelection = workspaceSelection;
		const previousSelectionChatId = workspaceSelectionChatId;
		const requestGeneration = ++workspaceSelectionRequestGeneration;
		workspaceOperation = 'clearing';
		try {
			const result = await hostApi.clearChatWorkspaceFolder(currentChatId);
			if (!result?.success) {
				throw new Error(result?.error || 'Failed to clear workspace folder');
			}
			if (
				requestGeneration !== workspaceSelectionRequestGeneration ||
				String(chatId || '').trim() !== currentChatId
			) {
				return;
			}
			workspaceSelection = result.selection;
			workspaceSelectionChatId = currentChatId;
			toast.success($i18n.t('Workspace folder reset'));
		} catch (error) {
			if (
				requestGeneration === workspaceSelectionRequestGeneration &&
				String(chatId || '').trim() === currentChatId
			) {
				workspaceSelection = previousSelection;
				workspaceSelectionChatId = previousSelectionChatId;
			}
			toast.error(error?.message || $i18n.t('Failed to clear workspace folder'));
		} finally {
			workspaceOperation = null;
		}
	}

	async function openChatWorkspaceFolder() {
		const currentChatId = await getWorkspaceChatId();
		const hostApi = getWorkspaceHostApi();
		if (!currentChatId || !hostApi?.openChatWorkspace || workspaceOpenInProgress) {
			return;
		}

		workspaceOpenInProgress = true;
		try {
			const result = await hostApi.openChatWorkspace(currentChatId);
			if (!result?.success) {
				throw new Error(result?.error || 'Failed to open workspace folder');
			}
		} catch (error) {
			toast.error(error?.message || $i18n.t('Failed to open workspace folder'));
		} finally {
			workspaceOpenInProgress = false;
		}
	}

	function handleWorkspaceBadgeClick() {
		if (selectedWorkspaceDisplayPath) {
			void openChatWorkspaceFolder();
		}
	}

	function handleWorkspaceBadgeKeydown(event: KeyboardEvent) {
		if (!selectedWorkspaceDisplayPath) {
			return;
		}
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			void openChatWorkspaceFolder();
		}
	}

	$: if (browser && String(chatId || '').trim() !== workspaceSelectionChatId) {
		void loadChatWorkspaceSelection();
	}

	// Handle artifacts-updated event from Electron
	function handleArtifactsUpdated(event: CustomEvent) {
		const detail = event.detail;
		console.log('[MessageInput] Received artifacts-updated event:', detail);
		if (detail && Array.isArray(detail.artifacts)) {
			artifacts = detail.artifacts;
		}
	}

	function handleChatWorkspaceSelectionUpdated(event: CustomEvent) {
		const detail = event.detail;
		const currentChatId = String(chatId || '').trim();
		if (
			!detail ||
			String(detail.chatId || '').trim() !== currentChatId ||
			!detail.selection
		) {
			return;
		}
		workspaceSelectionRequestGeneration += 1;
		workspaceSelection = detail.selection;
		workspaceSelectionChatId = currentChatId;
	}

	// PORTICO PATCH: Get model name and compute capabilities
	// For custom agents, resolve to base model for context window lookup
	$: selectedModelName = selectedModelIds.length === 1
		? $models.find(m => m.id === selectedModelIds[0])?.name
		: null;

	const getInputModelLogoSources = (model: Model | undefined) =>
		getModelLogoSources(
			model,
			WEBUI_API_BASE_URL,
			$i18n?.language || 'en',
			`${WEBUI_BASE_URL}/static/favicon.png`
		);
	let atSelectedModelRecord: Model | undefined = undefined;
	let atSelectedModelLogoSources = getInputModelLogoSources(undefined);
	$: atSelectedModelRecord =
		atSelectedModel?.id ? $models.find((model) => model.id === atSelectedModel.id) : undefined;
	$: atSelectedModelLogoSources = getModelLogoSources(
		atSelectedModelRecord,
		WEBUI_API_BASE_URL,
		$i18n?.language || 'en',
		`${WEBUI_BASE_URL}/static/favicon.png`
	);

	$: maxContextTokens = resolveModelMaxContextTokens($models, selectedModelIds);
	$: contextPercent = Math.min(100, (contextTokens / maxContextTokens) * 100);
	$: contextPercentLabel = (() => {
		if (contextPercent < 10) {
			return contextPercent.toFixed(1).replace(/\.0$/, '');
		}
		return `${Math.round(contextPercent)}`;
	})();
	$: remainingContextTokens = Math.max(0, maxContextTokens - contextTokens);

	// PORTICO PATCH: Per-model reasoning - initialize defaults and clean up when models change
	// Use index-based keys to support duplicate models (e.g., same model selected twice)
	// Models with reasoning capability and their available options
	// For custom agents, resolve to base model's capabilities via info.base_model_id
	$: reasoningCapableModels = selectedModelIds
		.map((id, index) => {
			const model = $models.find(m => m.id === id);
			if (!model?.name) return null;

			// For custom agents, resolve to base model's capabilities
			let lookupName = model.name;
			const displayName = model.name;
			const baseModelId = model.info?.base_model_id;

			if (baseModelId) {
				// This is a custom agent - find the base model for capability lookup
				const baseModel = $models.find(m => m.id === baseModelId);
				if (baseModel?.name) {
					lookupName = baseModel.name;
				}
			}

			const options = getReasoningEffortOptions(lookupName);
			if (!options || options.length === 0) return null;

			// Use index as key to support duplicate models
			// Store baseModelName for tooltip display when it's a custom agent
			return {
				index,
				id,
				name: displayName,
				baseModelName: baseModelId ? lookupName : null,
				options
			};
		})
		.filter(Boolean) as { index: number; id: string; name: string; baseModelName: string | null; options: ReasoningEffortOption[] }[];

	// PORTICO PATCH (fast mode): the lightning toggle renders only when a
	// selected model resolves to a GPT base (base_model_id-first, mirroring the
	// picker's provider grouping); the composer animation runs while the
	// toggle is on and a GPT model is still selected.
	$: fastModeEligible = selectedModelIds.some((id) =>
		isGptFastModeModel(
			$models.find((m) => m.id === id),
			$models
		)
	);
	$: fastModeActive = fastModeEnabled && fastModeEligible && !readOnlyMode;

	// PORTICO PATCH: Helper function to format token counts (e.g., 128000 -> "128k")
	const formatTokens = (n) => n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : n.toString();

	// PORTICO PATCH: Helper function to format cost (rounds to nearest cent)
	const formatCost = (cost: number) => {
		if (cost === 0) return '$0.00';
		return '$' + cost.toFixed(2);
	};

	const formatPercent = (value: number) => {
		const percent = Number.isFinite(value) ? value * 100 : 0;
		return `${percent.toFixed(Math.abs(percent) >= 10 ? 0 : 1)}%`;
	};

	let aggregateCacheSavingsTone: 'positive' | 'negative' | 'neutral' = 'neutral';
	$: aggregateCacheSavingsTone =
		aggregateCacheSavings > 0
			? 'positive'
			: aggregateCacheSavings < 0
				? 'negative'
				: 'neutral';

	let showInputVariablesModal = false;
	let inputVariablesModalCallback = (variableValues) => {};
	let inputVariables = {};
	let inputVariableValues = {};

	let showValvesModal = false;
	let selectedValvesType = 'tool'; // 'tool' or 'function'
	let selectedValvesItemId = null;
	let integrationsMenuCloseOnOutsideClick = true;

	$: if (!showValvesModal) {
		integrationsMenuCloseOnOutsideClick = true;
	}

	$: onChange({
		prompt,
		files: files
			.filter((file) => file.type !== 'image')
			.map((file) => {
				return {
					...file,
					user: undefined,
					access_control: undefined
				};
			}),
		selectedToolIds,
		selectedFilterIds,
		imageGenerationEnabled,
		webSearchEnabled,
		codeInterpreterEnabled,
		reasoningEffortByModel, // PORTICO PATCH: Include per-model reasoning effort in onChange
		fastModeEnabled // PORTICO PATCH (fast mode): keep the lightning toggle in session drafts
	});

	const inputVariableHandler = async (text: string): Promise<string> => {
		inputVariables = extractInputVariables(text);

		// No variables? return the original text immediately.
		if (Object.keys(inputVariables).length === 0) {
			return text;
		}

		// Show modal and wait for the user's input.
		showInputVariablesModal = true;
		return await new Promise<string>((resolve) => {
			inputVariablesModalCallback = (variableValues) => {
				inputVariableValues = { ...inputVariableValues, ...variableValues };
				replaceVariables(inputVariableValues);
				showInputVariablesModal = false;
				resolve(text);
			};
		});
	};

	const textVariableHandler = async (text: string) => {
		if (text.includes('{{CLIPBOARD}}')) {
			const clipboardText = await navigator.clipboard.readText().catch((err) => {
				toast.error($i18n.t('Failed to read clipboard contents'));
				return '{{CLIPBOARD}}';
			});

			const clipboardItems = await navigator.clipboard.read().catch((err) => {
				console.error('Failed to read clipboard items:', err);
				return [];
			});

			for (const item of clipboardItems) {
				for (const type of item.types) {
					if (type.startsWith('image/')) {
						const blob = await item.getType(type);
						const reader = new FileReader();
						reader.onload = (event) => {
							files = [
								...files,
								{
									type: 'image',
									url: event.target.result as string
								}
							];
						};
						reader.readAsDataURL(blob);
					}
				}
			}

			text = text.replaceAll('{{CLIPBOARD}}', clipboardText);
		}

		if (text.includes('{{USER_LOCATION}}')) {
			let location;
			try {
				location = await getUserPosition();
			} catch (error) {
				toast.error($i18n.t('Location access not allowed'));
				location = 'LOCATION_UNKNOWN';
			}
			text = text.replaceAll('{{USER_LOCATION}}', String(location));
		}

		const sessionUser = await getSessionUser(localStorage.token);

		if (text.includes('{{USER_NAME}}')) {
			const name = sessionUser?.name || 'User';
			text = text.replaceAll('{{USER_NAME}}', name);
		}

		if (text.includes('{{USER_BIO}}')) {
			const bio = sessionUser?.bio || '';

			if (bio) {
				text = text.replaceAll('{{USER_BIO}}', bio);
			}
		}

		if (text.includes('{{USER_GENDER}}')) {
			const gender = sessionUser?.gender || '';

			if (gender) {
				text = text.replaceAll('{{USER_GENDER}}', gender);
			}
		}

		if (text.includes('{{USER_BIRTH_DATE}}')) {
			const birthDate = sessionUser?.date_of_birth || '';

			if (birthDate) {
				text = text.replaceAll('{{USER_BIRTH_DATE}}', birthDate);
			}
		}

		if (text.includes('{{USER_AGE}}')) {
			const birthDate = sessionUser?.date_of_birth || '';

			if (birthDate) {
				// calculate age using date
				const age = getAge(birthDate);
				text = text.replaceAll('{{USER_AGE}}', age);
			}
		}

		if (text.includes('{{USER_LANGUAGE}}')) {
			const language = localStorage.getItem('locale') || 'en-US';
			text = text.replaceAll('{{USER_LANGUAGE}}', language);
		}

		if (text.includes('{{CURRENT_DATE}}')) {
			const date = getFormattedDate();
			text = text.replaceAll('{{CURRENT_DATE}}', date);
		}

		if (text.includes('{{CURRENT_TIME}}')) {
			const time = getFormattedTime();
			text = text.replaceAll('{{CURRENT_TIME}}', time);
		}

		if (text.includes('{{CURRENT_DATETIME}}')) {
			const dateTime = getCurrentDateTime();
			text = text.replaceAll('{{CURRENT_DATETIME}}', dateTime);
		}

		if (text.includes('{{CURRENT_TIMEZONE}}')) {
			const timezone = getUserTimezone();
			text = text.replaceAll('{{CURRENT_TIMEZONE}}', timezone);
		}

		if (text.includes('{{CURRENT_WEEKDAY}}')) {
			const weekday = getWeekday();
			text = text.replaceAll('{{CURRENT_WEEKDAY}}', weekday);
		}

		return text;
	};

	const replaceVariables = (variables: Record<string, any>) => {
		console.log('Replacing variables:', variables);

		const chatInput = document.getElementById('chat-input');

		if (chatInput) {
			chatInputElement.replaceVariables(variables);
			chatInputElement.focus();
		}
	};

	export const setText = async (text?: string, cb?: (text: string) => void) => {
		const chatInput = document.getElementById('chat-input');

		if (chatInput) {
			if (text !== '') {
				text = await textVariableHandler(text || '');
			}

			chatInputElement?.setText(text);
			chatInputElement?.focus();

			if (text !== '') {
				text = await inputVariableHandler(text);
			}

			await tick();
			if (cb) await cb(text);
		}
	};

	const getCommand = () => {
		const chatInput = document.getElementById('chat-input');
		let word = '';

		if (chatInput) {
			word = chatInputElement?.getWordAtDocPos();
		}

		return word;
	};

	const replaceCommandWithText = (text) => {
		const chatInput = document.getElementById('chat-input');
		if (!chatInput) return;

		chatInputElement?.replaceCommandWithText(text);
	};

	const insertTextAtCursor = async (text: string) => {
		const chatInput = document.getElementById('chat-input');
		if (!chatInput) return;

		text = await textVariableHandler(text);

		if (command) {
			replaceCommandWithText(text);
		} else {
			chatInputElement?.insertContent(text);
		}

		await tick();
		text = await inputVariableHandler(text);
		await tick();

		const chatInputContainer = document.getElementById('chat-input-container');
		if (chatInputContainer) {
			chatInputContainer.scrollTop = chatInputContainer.scrollHeight;
		}

		await tick();
		if (chatInput) {
			chatInput.focus();
			chatInput.dispatchEvent(new Event('input'));

			const words = extractCurlyBraceWords(prompt);

			if (words.length > 0) {
				const word = words.at(0);
				await tick();
			} else {
				chatInput.scrollTop = chatInput.scrollHeight;
			}
		}
	};

	let command = '';
	export let showCommands = false;
	$: showCommands = ['/', '#', '@'].includes(command?.charAt(0)) || '\\#' === command?.slice(0, 2);
	let suggestions = null;

	let showTools = false;

	let loaded = false;
	let recording = false;

	let isComposing = false;
	// Safari has a bug where compositionend is not triggered correctly #16615
	// when using the virtual keyboard on iOS.
	let compositionEndedAt = -2e8;
	const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
	function inOrNearComposition(event: Event) {
		if (isComposing) {
			return true;
		}
		// See https://www.stum.de/2016/06/24/handling-ime-events-in-javascript/.
		// On Japanese input method editors (IMEs), the Enter key is used to confirm character
		// selection. On Safari, when Enter is pressed, compositionend and keydown events are
		// emitted. The keydown event triggers newline insertion, which we don't want.
		// This method returns true if the keydown event should be ignored.
		// We only ignore it once, as pressing Enter a second time *should* insert a newline.
		// Furthermore, the keydown event timestamp must be close to the compositionEndedAt timestamp.
		// This guards against the case where compositionend is triggered without the keyboard
		// (e.g. character confirmation may be done with the mouse), and keydown is triggered
		// afterwards- we wouldn't want to ignore the keydown event in this case.
		if (isSafari && Math.abs(event.timeStamp - compositionEndedAt) < 500) {
			compositionEndedAt = -2e8;
			return true;
		}
		return false;
	}

	let chatInputContainerElement;
	let chatInputElement;

	let filesInputElement;
	let commandsElement;

	let inputFiles;

	let dragged = false;
	let shiftKey = false;
	let steerSubmitKeycaps = ['Enter'];
	let queueSubmitKeycaps = ['Alt', 'Enter'];
	let queueEditPreviousKeycaps = ['Alt', 'Up'];
	let queueEditNextKeycaps = ['Alt', 'Down'];

	let user = null;
	export let placeholder = '';

	type CaretDocument = Document & {
		caretPositionFromPoint?: (
			x: number,
			y: number
		) => { offsetNode: Node; offset: number } | null;
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
	};

	let visionCapableModels = [];
	$: visionCapableModels = (atSelectedModel?.id ? [atSelectedModel.id] : selectedModels).filter(
		(model) => $models.find((m) => m.id === model)?.info?.meta?.capabilities?.vision ?? true
	);

	let fileUploadCapableModels = [];
	$: fileUploadCapableModels = (atSelectedModel?.id ? [atSelectedModel.id] : selectedModels).filter(
		(model) => $models.find((m) => m.id === model)?.info?.meta?.capabilities?.file_upload ?? true
	);

	let webSearchCapableModels = [];
	$: webSearchCapableModels = (atSelectedModel?.id ? [atSelectedModel.id] : selectedModels).filter(
		(model) => $models.find((m) => m.id === model)?.info?.meta?.capabilities?.web_search ?? true
	);

	let imageGenerationCapableModels = [];
	$: imageGenerationCapableModels = (
		atSelectedModel?.id ? [atSelectedModel.id] : selectedModels
	).filter(
		(model) =>
			$models.find((m) => m.id === model)?.info?.meta?.capabilities?.image_generation ?? true
	);

	let codeInterpreterCapableModels = [];
	$: codeInterpreterCapableModels = (
		atSelectedModel?.id ? [atSelectedModel.id] : selectedModels
	).filter(
		(model) =>
			$models.find((m) => m.id === model)?.info?.meta?.capabilities?.code_interpreter ?? true
	);

	let toggleFilters = [];
	$: toggleFilters = (atSelectedModel?.id ? [atSelectedModel.id] : selectedModels)
		.map((id) => ($models.find((model) => model.id === id) || {})?.filters ?? [])
		.reduce((acc, filters) => acc.filter((f1) => filters.some((f2) => f2.id === f1.id)));

	let showToolsButton = false;
	$: showToolsButton = ($tools ?? []).length > 0 || ($toolServers ?? []).length > 0;

	let showWebSearchButton = false;
	$: showWebSearchButton =
		(atSelectedModel?.id ? [atSelectedModel.id] : selectedModels).length ===
			webSearchCapableModels.length &&
		$config?.features?.enable_web_search &&
		($_user.role === 'admin' || $_user?.permissions?.features?.web_search);

	let showImageGenerationButton = false;
	$: showImageGenerationButton =
		(atSelectedModel?.id ? [atSelectedModel.id] : selectedModels).length ===
			imageGenerationCapableModels.length &&
		$config?.features?.enable_image_generation &&
		($_user.role === 'admin' || $_user?.permissions?.features?.image_generation);

	let showCodeInterpreterButton = false;
	$: showCodeInterpreterButton =
		(atSelectedModel?.id ? [atSelectedModel.id] : selectedModels).length ===
			codeInterpreterCapableModels.length &&
		$config?.features?.enable_code_interpreter &&
		($_user.role === 'admin' || $_user?.permissions?.features?.code_interpreter);

	const SCROLL_EDGE_THRESHOLD_PX = 4;
	let canScrollUp = false;
	let canScrollDown = false;
	let messagesContainerElement: HTMLElement | null = null;

	const handleMessagesContainerScroll = () => {
		updateScrollButtonState();
	};

	const bindMessagesContainerElement = () => {
		const element = document.getElementById('messages-container');
		if (!element || element === messagesContainerElement) return;

		if (messagesContainerElement) {
			messagesContainerElement.removeEventListener('scroll', handleMessagesContainerScroll);
		}

		messagesContainerElement = element;
		messagesContainerElement.addEventListener('scroll', handleMessagesContainerScroll, {
			passive: true
		});
	};

	const updateScrollButtonState = () => {
		bindMessagesContainerElement();
		if (!messagesContainerElement) {
			canScrollUp = false;
			canScrollDown = false;
			return;
		}

		const maxScrollTop = Math.max(
			0,
			messagesContainerElement.scrollHeight - messagesContainerElement.clientHeight
		);
		canScrollUp = messagesContainerElement.scrollTop > SCROLL_EDGE_THRESHOLD_PX;
		canScrollDown =
			maxScrollTop - messagesContainerElement.scrollTop > SCROLL_EDGE_THRESHOLD_PX;
	};

	$: if (browser && loaded && hasConversation) {
		// Keep the button visibility in sync when content changes programmatically.
		updateScrollButtonState();
	}

	const scrollToBottom = () => {
		const element = document.getElementById('messages-container');
		if (!element) return;
		element.scrollTo({
			top: element.scrollHeight,
			behavior: 'smooth'
		});
	};

	// PORTICO_PATCH: Companion to scrollToBottom for navigating to chat start.
	const scrollToTop = () => {
		const element = document.getElementById('messages-container');
		if (!element) return;
		element.scrollTo({
			top: 0,
			behavior: 'smooth'
		});
	};

	const screenCaptureHandler = async () => {
		try {
			// Request screen media
			const mediaStream = await navigator.mediaDevices.getDisplayMedia({
				video: { cursor: 'never' },
				audio: false
			});
			// Once the user selects a screen, temporarily create a video element
			const video = document.createElement('video');
			video.srcObject = mediaStream;
			// Ensure the video loads without affecting user experience or tab switching
			await video.play();
			// Set up the canvas to match the video dimensions
			const canvas = document.createElement('canvas');
			canvas.width = video.videoWidth;
			canvas.height = video.videoHeight;
			// Grab a single frame from the video stream using the canvas
			const context = canvas.getContext('2d');
			context.drawImage(video, 0, 0, canvas.width, canvas.height);
			// Stop all video tracks (stop screen sharing) after capturing the image
			mediaStream.getTracks().forEach((track) => track.stop());

			// bring back focus to this current tab, so that the user can see the screen capture
			window.focus();

			// Convert the canvas to a Base64 image URL
			const imageUrl = canvas.toDataURL('image/png');
			// Add the captured image to the files array to render it
			files = [...files, { type: 'image', url: imageUrl }];
			// Clean memory: Clear video srcObject
			video.srcObject = null;
		} catch (error) {
			// Handle any errors (e.g., user cancels screen sharing)
			console.error('Error capturing screen:', error);
		}
	};

	const uploadFileHandler = async (file, process = true, itemData = {}) => {
		if ($_user?.role !== 'admin' && !($_user?.permissions?.chat?.file_upload ?? true)) {
			toast.error($i18n.t('You do not have permission to upload files.'));
			return null;
		}

		if (fileUploadCapableModels.length !== selectedModels.length) {
			toast.error($i18n.t('Model(s) do not support file upload'));
			return null;
		}

		const tempItemId = uuidv4();
		const fileItem = {
			type: 'file',
			file: '',
			id: null,
			url: '',
			name: file.name,
			collection_name: '',
			status: 'uploading',
			size: file.size,
			error: '',
			itemId: tempItemId,
			...itemData
		};

		if (fileItem.size == 0) {
			toast.error($i18n.t('You cannot upload an empty file.'));
			return null;
		}

		files = [...files, fileItem];

		if (!$temporaryChatEnabled) {
			try {
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

				// During the file upload, file content is automatically extracted.
				const uploadedFile = await uploadFile(localStorage.token, file, metadata, process);

				if (uploadedFile) {
					console.log('File upload completed:', {
						id: uploadedFile.id,
						name: fileItem.name,
						collection: uploadedFile?.meta?.collection_name
					});

					if (uploadedFile.error) {
						console.warn('File upload warning:', uploadedFile.error);
						toast.warning(uploadedFile.error);
					}

					fileItem.status = 'uploaded';
					fileItem.file = uploadedFile;
					fileItem.id = uploadedFile.id;
					fileItem.collection_name =
						uploadedFile?.meta?.collection_name || uploadedFile?.collection_name;
					fileItem.content_type = uploadedFile.meta?.content_type || uploadedFile.content_type;
					fileItem.url = `${uploadedFile.id}`;

					files = files;
				} else {
					files = files.filter((item) => item?.itemId !== tempItemId);
				}
			} catch (e) {
				toast.error(`${e}`);
				files = files.filter((item) => item?.itemId !== tempItemId);
			}
		} else {
			// If temporary chat is enabled, we just add the file to the list without uploading it.

			const content = await extractContentFromFile(file).catch((error) => {
				toast.error(
					$i18n.t('Failed to extract content from the file: {{error}}', { error: error })
				);
				return null;
			});

			if (content === null) {
				toast.error($i18n.t('Failed to extract content from the file.'));
				files = files.filter((item) => item?.itemId !== tempItemId);
				return null;
			} else {
				console.log('Extracted content from file:', {
					name: file.name,
					size: file.size,
					content: content
				});

				fileItem.status = 'uploaded';
				fileItem.type = 'text';
				fileItem.content = content;
				fileItem.id = uuidv4(); // Temporary ID for the file

				files = files;
			}
		}
	};

	const inputFilesHandler = async (inputFiles) => {
		console.log('Input files handler called with:', inputFiles);

		if (
			($config?.file?.max_count ?? null) !== null &&
			files.length + inputFiles.length > $config?.file?.max_count
		) {
			toast.error(
				$i18n.t(`You can only chat with a maximum of {{maxCount}} file(s) at a time.`, {
					maxCount: $config?.file?.max_count
				})
			);
			return;
		}

		inputFiles.forEach(async (file) => {
			console.log('Processing file:', {
				name: file.name,
				type: file.type,
				size: file.size,
				extension: file.name.split('.').at(-1)
			});

			if (
				($config?.file?.max_size ?? null) !== null &&
				file.size > ($config?.file?.max_size ?? 0) * 1024 * 1024
			) {
				console.log('File exceeds max size limit:', {
					fileSize: file.size,
					maxSize: ($config?.file?.max_size ?? 0) * 1024 * 1024
				});
				toast.error(
					$i18n.t(`File size should not exceed {{maxSize}} MB.`, {
						maxSize: $config?.file?.max_size
					})
				);
				return;
			}

			if (file['type'].startsWith('image/')) {
				if (visionCapableModels.length === 0) {
					toast.error($i18n.t('Selected model(s) do not support image inputs'));
					return;
				}

				const compressImageHandler = async (imageUrl, settings = {}, config = {}) => {
					// Quick shortcut so we don’t do unnecessary work.
					const settingsCompression = settings?.imageCompression ?? false;
					const configWidth = config?.file?.image_compression?.width ?? null;
					const configHeight = config?.file?.image_compression?.height ?? null;

					// If neither settings nor config wants compression, return original URL.
					if (!settingsCompression && !configWidth && !configHeight) {
						return imageUrl;
					}

					// Default to null (no compression unless set)
					let width = null;
					let height = null;

					// If user/settings want compression, pick their preferred size.
					if (settingsCompression) {
						width = settings?.imageCompressionSize?.width ?? null;
						height = settings?.imageCompressionSize?.height ?? null;
					}

					// Apply config limits as an upper bound if any
					if (configWidth && (width === null || width > configWidth)) {
						width = configWidth;
					}
					if (configHeight && (height === null || height > configHeight)) {
						height = configHeight;
					}

					// Do the compression if required
					if (width || height) {
						return await compressImage(imageUrl, width, height);
					}
					return imageUrl;
				};

				let reader = new FileReader();
				reader.onload = async (event) => {
					let imageUrl = event.target.result;

					imageUrl = await compressImageHandler(imageUrl, $settings, $config);

					files = [
						...files,
						{
							type: 'image',
							url: `${imageUrl}`
						}
					];
				};
				reader.readAsDataURL(file['type'] === 'image/heic' ? await convertHeicToJpeg(file) : file);
			} else {
				uploadFileHandler(file);
			}
		});
	};

	const onDragOver = (e) => {
		e.preventDefault();
		if (nativeInputInteractionLocked) {
			dragged = false;
			return;
		}

		// Check if a file is being dragged.
		if (e.dataTransfer?.types?.includes('Files')) {
			dragged = true;
		} else {
			dragged = false;
		}
	};

	const onDragLeave = () => {
		dragged = false;
	};

	const onDrop = async (e) => {
		e.preventDefault();
		if (nativeInputInteractionLocked) {
			dragged = false;
			return;
		}
		console.log(e);

		if (e.dataTransfer?.files) {
			const inputFiles = Array.from(e.dataTransfer?.files);
			if (inputFiles && inputFiles.length > 0) {
				console.log(inputFiles);
				inputFilesHandler(inputFiles);
			}
		}

		dragged = false;
	};

	const onKeyDown = (e) => {
		if (e.key === 'Shift') {
			shiftKey = true;
		}

		if (e.key === 'Escape') {
			console.log('Escape');
			dragged = false;
		}
	};

	const onKeyUp = (e) => {
		if (e.key === 'Shift') {
			shiftKey = false;
		}
	};

	const isLocalFindOverlayActive = () =>
		document.documentElement?.dataset?.porticoLocalFindActive === 'true';

	const onFocus = () => {
		if (isLocalFindOverlayActive()) {
			return;
		}
		void focusComposer();
	};
	let editorSelectionSnapshot: Range | null = null;

	const getChatInputElement = () =>
		document.getElementById('chat-input-container')?.querySelector(
			'.ProseMirror[contenteditable="true"], [contenteditable="true"]'
		) as HTMLElement | null;

	const captureComposerSelection = () => {
		const editorElement = getChatInputElement();
		const selection = window.getSelection();
		if (!editorElement || !selection || selection.rangeCount === 0) return;

		const range = selection.getRangeAt(0);
		if (!editorElement.contains(range.startContainer) || !editorElement.contains(range.endContainer)) {
			return;
		}

		editorSelectionSnapshot = range.cloneRange();
	};

	const restoreComposerSelection = () => {
		if (!editorSelectionSnapshot) return;
		const selection = window.getSelection();
		if (!selection) return;

		try {
			selection.removeAllRanges();
			selection.addRange(editorSelectionSnapshot.cloneRange());
		} catch (error) {
			console.debug('[MessageInput] Failed to restore composer selection:', error);
		}
	};

	const focusComposer = async () => {
		if (readOnlyMode || nativeInputInteractionLocked) return;
		await tick();
		chatInputElement?.focus?.();
		const editorElement = getChatInputElement();
		editorElement?.focus?.({ preventScroll: true });
		restoreComposerSelection();
	};

	const getPendingAttachmentSummary = (item: PendingWorkItem | null) => {
		if (!item?.files?.length) return '';
		const namedFiles = item.files
			.map((file) => file?.name || file?.filename || (file?.type === 'image' ? 'image' : 'file'))
			.slice(0, 2);
		const remainder = item.files.length - namedFiles.length;
		return remainder > 0 ? `${namedFiles.join(', ')} +${remainder}` : namedFiles.join(', ');
	};

	const getPendingWorkPreview = (item: PendingWorkItem | null) => {
		return getPendingWorkPreviewText(item);
	};

	$: isEditingPendingWork = pendingWorkEditMode !== 'none';
	$: isBlankPendingWorkDraft = prompt === '' && files.length === 0;
	$: saveButtonEnabled = isEditingPendingWork ? true : !isBlankPendingWorkDraft;
	$: pendingWorkPrimaryActionLabel =
		isEditingPendingWork && isBlankPendingWorkDraft ? $i18n.t('Delete') : $i18n.t('Save');

	const handleComposerSubmit = async () => {
		if (nativeInputInteractionLocked) return;
		if (pendingWorkEditMode === 'steer') {
			await onSubmitPendingSteer();
			return;
		}

		if (pendingWorkEditMode === 'queue') {
			await onSubmitQueuedPrompt();
			return;
		}

		dispatch('submit', prompt);
	};

	const onBlur = () => {
		captureComposerSelection();
		shiftKey = false;
	};

	const isPointInsideRect = (x: number, y: number, rect: DOMRect) =>
		x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

	const placeEditorCaretFromPoint = (editorElement: HTMLElement, x: number, y: number) => {
		const selection = window.getSelection();
		if (!selection) return;

		const caretDocument = document as CaretDocument;
		let range: Range | null = null;

		if (typeof caretDocument.caretPositionFromPoint === 'function') {
			const caretPosition = caretDocument.caretPositionFromPoint(x, y);
			if (caretPosition && editorElement.contains(caretPosition.offsetNode)) {
				range = document.createRange();
				range.setStart(caretPosition.offsetNode, caretPosition.offset);
				range.collapse(true);
			}
		}

		if (!range && typeof caretDocument.caretRangeFromPoint === 'function') {
			const caretRange = caretDocument.caretRangeFromPoint(x, y);
			if (caretRange && editorElement.contains(caretRange.startContainer)) {
				range = caretRange.cloneRange();
				range.collapse(true);
			}
		}

		if (!range) return;

		editorElement.focus({ preventScroll: true });
		selection.removeAllRanges();
		selection.addRange(range);
		editorSelectionSnapshot = range.cloneRange();
	};

	const placeEditorCaretAtEnd = (editorElement: HTMLElement) => {
		const selection = window.getSelection();
		if (!selection) return;

		const range = document.createRange();
		range.selectNodeContents(editorElement);
		range.collapse(false);

		editorElement.focus({ preventScroll: true });
		selection.removeAllRanges();
		selection.addRange(range);
		editorSelectionSnapshot = range.cloneRange();
	};

	const handleEditorMouseDownCapture = (event: MouseEvent) => {
		if (event.button !== 0) return;
		const target = event.target as HTMLElement | null;
		if (!target) return;

		// Respect clicks on explicit controls inside the input area.
		if (target.closest('button, a, input, select, textarea, label, [role="button"]')) return;

		const messageInputContainer = document.getElementById('message-input-container');
		if (!messageInputContainer || !messageInputContainer.contains(target)) return;

		const chatInputContainer = document.getElementById('chat-input-container');
		if (!chatInputContainer) return;

		const editorElement = getChatInputElement();
		if (!editorElement) return;

		// If the click already landed on the real editor surface, keep native behavior.
		if (target.closest('[contenteditable="true"]')) return;

		const editorRect = editorElement.getBoundingClientRect();
		window.requestAnimationFrame(() => {
			if (isPointInsideRect(event.clientX, event.clientY, editorRect)) {
				placeEditorCaretFromPoint(editorElement, event.clientX, event.clientY);
				return;
			}

			placeEditorCaretAtEnd(editorElement);
		});
	};

	onMount(async () => {
		window.addEventListener(
			'owui-native-input-presentation-snapshot',
			handleNativeInputPresentationSnapshot as EventListener
		);
		const hostApi = (window as any)?.webviewHost;
		if (typeof hostApi?.getNativeInputPresentationSnapshot === 'function') {
			try {
				applyNativeInputPresentationSnapshot(
					await hostApi.getNativeInputPresentationSnapshot()
				);
			} catch (error) {
				console.warn('[MessageInput] Failed to load native-input presentation:', error);
			}
		}

		const platformLabel = navigator.platform || navigator.userAgent || '';
		steerSubmitKeycaps = getPendingWorkShortcutKeycaps(platformLabel, 'steer-submit');
		queueSubmitKeycaps = getPendingWorkShortcutKeycaps(platformLabel, 'queue-submit');
		queueEditPreviousKeycaps = getPendingWorkShortcutKeycaps(
			platformLabel,
			'queue-edit-previous'
		);
		queueEditNextKeycaps = getPendingWorkShortcutKeycaps(platformLabel, 'queue-edit-next');

		suggestions = [
			{
				char: '@',
				render: getSuggestionRenderer(CommandSuggestionList, {
					i18n,
					onSelect: (e) => {
						const { type, data } = e;

						if (type === 'model') {
							atSelectedModel = data;
						}

						document.getElementById('chat-input')?.focus();
					},

					insertTextHandler: insertTextAtCursor,
					onUpload: (e) => {
						const { type, data } = e;

						if (type === 'file') {
							if (files.find((f) => f.id === data.id)) {
								return;
							}
							files = [
								...files,
								{
									...data,
									status: 'processed'
								}
							];
						} else {
							onUpload(e);
						}
					}
				})
			},
			{
				char: '/',
				render: getSuggestionRenderer(CommandSuggestionList, {
					i18n,
					onSelect: (e) => {
						const { type, data } = e;

						if (type === 'model') {
							atSelectedModel = data;
						}

						document.getElementById('chat-input')?.focus();
					},

					insertTextHandler: insertTextAtCursor,
					onUpload: (e) => {
						const { type, data } = e;

						if (type === 'file') {
							if (files.find((f) => f.id === data.id)) {
								return;
							}
							files = [
								...files,
								{
									...data,
									status: 'processed'
								}
							];
						} else {
							onUpload(e);
						}
					}
				})
			},
			{
				char: '#',
				render: getSuggestionRenderer(CommandSuggestionList, {
					i18n,
					onSelect: (e) => {
						const { type, data } = e;

						if (type === 'model') {
							atSelectedModel = data;
						}

						document.getElementById('chat-input')?.focus();
					},

					insertTextHandler: insertTextAtCursor,
					onUpload: (e) => {
						const { type, data } = e;

						if (type === 'file') {
							if (files.find((f) => f.id === data.id)) {
								return;
							}
							files = [
								...files,
								{
									...data,
									status: 'processed'
								}
							];
						} else {
							onUpload(e);
						}
					}
				})
			}
		];
		loaded = true;

		window.setTimeout(() => {
			const chatInput = document.getElementById('chat-input');
			chatInput?.focus();
		}, 0);

		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		document.addEventListener('mousedown', handleEditorMouseDownCapture, true);

		window.addEventListener('focus', onFocus);
		window.addEventListener('blur', onBlur);

		// PORTICO PATCH: Listen for artifacts-updated event from Electron
		window.addEventListener('artifacts-updated', handleArtifactsUpdated as EventListener);
		window.addEventListener(
			'chat-workspace-selection-updated',
			handleChatWorkspaceSelectionUpdated as EventListener
		);
		// Also register a global callback that Electron can call directly (more reliable than events)
		(window as any).__updateArtifacts = (detail: any) => {
			console.log('[MessageInput] __updateArtifacts called directly:', detail);
			if (detail && Array.isArray(detail.artifacts)) {
				artifacts = detail.artifacts;
			}
		};
		console.log('[MessageInput] Set up artifacts-updated event listener and global callback');

		await tick();

		const dropzoneElement = document.getElementById('chat-container');
		bindMessagesContainerElement();
		updateScrollButtonState();

		dropzoneElement?.addEventListener('dragover', onDragOver);
		dropzoneElement?.addEventListener('drop', onDrop);
		dropzoneElement?.addEventListener('dragleave', onDragLeave);

		await tools.set(await getTools(localStorage.token));
	});

	onDestroy(() => {
		console.log('destroy');
		window.removeEventListener('keydown', onKeyDown);
		window.removeEventListener('keyup', onKeyUp);
		document.removeEventListener('mousedown', handleEditorMouseDownCapture, true);

		window.removeEventListener('focus', onFocus);
		window.removeEventListener('blur', onBlur);
		window.removeEventListener(
			'owui-native-input-presentation-snapshot',
			handleNativeInputPresentationSnapshot as EventListener
		);

		// PORTICO PATCH: Clean up artifacts-updated listener and global callback
		window.removeEventListener('artifacts-updated', handleArtifactsUpdated as EventListener);
		window.removeEventListener(
			'chat-workspace-selection-updated',
			handleChatWorkspaceSelectionUpdated as EventListener
		);
		delete (window as any).__updateArtifacts;

		const dropzoneElement = document.getElementById('chat-container');

		if (dropzoneElement) {
			dropzoneElement?.removeEventListener('dragover', onDragOver);
			dropzoneElement?.removeEventListener('drop', onDrop);
			dropzoneElement?.removeEventListener('dragleave', onDragLeave);
		}

		if (messagesContainerElement) {
			messagesContainerElement.removeEventListener('scroll', handleMessagesContainerScroll);
			messagesContainerElement = null;
		}
	});
</script>

<FilesOverlay show={dragged} />
<ToolServersModal bind:show={showTools} {selectedToolIds} />

<InputVariablesModal
	bind:show={showInputVariablesModal}
	variables={inputVariables}
	onSave={inputVariablesModalCallback}
/>

<ValvesModal
	bind:show={showValvesModal}
	userValves={true}
	type={selectedValvesType}
	id={selectedValvesItemId ?? null}
	on:save={async () => {
		await tick();
	}}
	on:close={() => {
		integrationsMenuCloseOnOutsideClick = true;
	}}
/>

{#if loaded}
	<div class="w-full font-primary">
		<div class=" mx-auto inset-x-0 bg-transparent flex justify-center">
			<div
				class="flex flex-col px-2.5 {($settings?.widescreenMode ?? null)
					? 'max-w-full'
					: 'max-w-6xl'} w-full"
			>
				<div class="relative">
				{#if hasConversation}
					<div
						class="chat-scroll-navigation absolute z-30 pointer-events-none flex flex-col gap-2 top-1/2 -translate-y-1/2 -right-12"
						use:portalTo={messageInputContainerElement}
					>
						<button
							type="button"
							aria-label="Scroll to top"
							disabled={!canScrollUp}
							class="bg-white border border-gray-100 text-gray-700 dark:border-none dark:bg-white/20 dark:text-white p-1.5 rounded-full pointer-events-auto transition-opacity disabled:opacity-45 disabled:cursor-default"
							on:click={() => {
								if (!canScrollUp) return;
								autoScroll = false;
								scrollToTop();
							}}
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 20 20"
								fill="currentColor"
								class="w-5 h-5"
							>
								<path
									fill-rule="evenodd"
									d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04L10.75 5.612V16.25A.75.75 0 0110 17z"
									clip-rule="evenodd"
								/>
							</svg>
						</button>
						<button
							type="button"
							aria-label="Scroll to bottom"
							disabled={!canScrollDown}
							class="bg-white border border-gray-100 text-gray-700 dark:border-none dark:bg-white/20 dark:text-white p-1.5 rounded-full pointer-events-auto transition-opacity disabled:opacity-45 disabled:cursor-default"
							on:click={() => {
								if (!canScrollDown) return;
								autoScroll = true;
								scrollToBottom();
							}}
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 20 20"
								fill="currentColor"
								class="w-5 h-5"
							>
								<path
									fill-rule="evenodd"
									d="M10 3a.75.75 0 01.75.75v10.638l3.96-4.158a.75.75 0 111.08 1.04l-5.25 5.5a.75.75 0 01-1.08 0l-5.25-5.5a.75.75 0 111.08-1.04l3.96 4.158V3.75A.75.75 0 0110 3z"
									clip-rule="evenodd"
								/>
							</svg>
						</button>
					</div>
				{/if}
				</div>
			</div>
		</div>

		<div class="bg-transparent">
			<div
				class="{($settings?.widescreenMode ?? null)
					? 'max-w-full'
					: 'max-w-6xl'} px-2.5 mx-auto inset-x-0"
			>
				<div class="">
					<input
						bind:this={filesInputElement}
						bind:files={inputFiles}
						type="file"
						hidden
						multiple
						on:change={async () => {
							if (inputFiles && inputFiles.length > 0) {
								const _inputFiles = Array.from(inputFiles);
								inputFilesHandler(_inputFiles);
							} else {
								toast.error($i18n.t(`File not found.`));
							}

							filesInputElement.value = '';
						}}
					/>

					<div class={recording ? '' : 'hidden'} inert={nativeInputInteractionLocked}>
						<VoiceRecording
							bind:recording
							onCancel={async () => {
								recording = false;

								await tick();
								document.getElementById('chat-input')?.focus();
							}}
							onConfirm={async (data) => {
								const { text, filename } = data;

								recording = false;

								await tick();
								await insertTextAtCursor(`${text}`);
								await tick();
								document.getElementById('chat-input')?.focus();

								if ($settings?.speechAutoSend ?? false) {
									dispatch('submit', prompt);
								}
							}}
						/>
					</div>
					<form
						class="w-full flex flex-col gap-1.5 {readOnlyMode ? 'items-center' : ''} {recording
							? 'hidden'
							: ''}"
						on:submit|preventDefault={async () => {
							// check if selectedModels support image input
							await handleComposerSubmit();
						}}
					>
						<button
							id="generate-message-pair-button"
							class="hidden"
							on:click={() => createMessagePair(prompt)}
						/>

						<div id="message-input-rail" class="relative flex w-full flex-col gap-2">
							{#if hiddenNativeInputFlow}
								<button
									type="button"
									class="question-attention-bar flex w-full items-center gap-3 rounded-2xl border border-blue-300/80 bg-blue-50 px-3.5 py-2.5 text-left text-blue-950 shadow-sm transition hover:border-blue-400 hover:bg-blue-100 disabled:cursor-wait disabled:opacity-70 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-blue-50 dark:hover:border-blue-300/50 dark:hover:bg-blue-500/20"
									disabled={reopeningNativeInput}
									aria-label={nativeInputAttentionTitle}
									on:click={reopenHiddenNativeInput}
								>
									<span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white dark:bg-blue-400 dark:text-blue-950" aria-hidden="true">
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="size-4.5">
											<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
											<circle cx="12" cy="12" r="3" />
										</svg>
									</span>
									<span class="min-w-0 flex-1">
										<span class="block text-sm font-semibold">{nativeInputAttentionTitle}</span>
										<span class="block text-xs text-blue-700 dark:text-blue-200">
											{nativeInputAttentionDescription}
										</span>
									</span>
									<span class="shrink-0 rounded-full border border-blue-300/80 bg-white/70 px-2 py-0.5 text-xs font-semibold text-blue-700 dark:border-blue-300/20 dark:bg-black/15 dark:text-blue-100">
										{hiddenNativeInputFlow.kind === 'marketplace_publish'
											? marketplaceApprovalCount
											: hiddenNativeInputFlow.item_count}
									</span>
								</button>
							{/if}
							{#if crossPaneTargetLabel}
								<!-- Multi-chat: unambiguous send-target indicator. -->
								<div class="flex w-full justify-start">
									<span
										class="cross-pane-target-chip inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-4"
										style={badgeStyleVars(crossPaneTargetLabel)}
									>
										<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" class="size-3 shrink-0" aria-hidden="true">
											<path d="M2.5 8h10M9 4.5 12.5 8 9 11.5" stroke-linecap="round" stroke-linejoin="round" />
										</svg>
										{crossPaneTargetLabel}
									</span>
								</div>
							{/if}

							<div
								id="message-input-container"
								bind:this={messageInputContainerElement}
								class="relative rounded-3xl border {$temporaryChatEnabled
									? 'border-dashed border-slate-300/80 hover:border-slate-400 focus-within:border-slate-400 dark:border-gray-800 dark:hover:border-gray-700 dark:focus-within:border-gray-700'
									: 'border-slate-300/75 hover:border-slate-400 focus-within:border-slate-500 dark:border-gray-850/30 dark:hover:border-gray-800 dark:focus-within:border-gray-800'} transition bg-slate-100/85 dark:bg-gray-500/5 backdrop-blur-sm text-slate-900 dark:text-gray-100"
								class:subagent-badge-shell={readOnlyMode}
								class:flex-1={!readOnlyMode}
								class:flex={true}
								class:flex-col={true}
								class:w-full={!readOnlyMode}
								class:w-auto={readOnlyMode}
								class:min-w-0={readOnlyMode}
								class:self-center={readOnlyMode}
								class:px-1={!readOnlyMode}
								class:px-3={readOnlyMode}
								class:py-3={readOnlyMode}
								class:justify-center={readOnlyMode}
								class:opacity-75={nativeInputInteractionLocked}
								class:composer-fast-mode={fastModeActive}
								dir={$settings?.chatDirection ?? 'auto'}
							>
							{#if !readOnlyMode && isStreaming}
								<!-- Condensed steer/queue hint: a one-line watermark floated just
								     above the composer's top-right corner (absolute, out of
								     flow — zero vertical real-estate cost in the layout). -->
								<div
									class="composer-hotkey-watermark pointer-events-none absolute right-2 bottom-full mb-1.5 z-10 inline-flex select-none items-center gap-1 text-[9px] font-medium text-slate-400/90 dark:text-slate-500/90"
									aria-hidden="true"
								>
									{#each steerSubmitKeycaps as keycap, keycapIndex}
										{#if keycapIndex > 0}<span>+</span>{/if}
										<span class="composer-hotkey-keycap">{keycap}</span>
									{/each}
									<span>{$i18n.t('steer')}</span>
									<span class="mx-0.5 opacity-60">·</span>
									{#each queueSubmitKeycaps as keycap, keycapIndex}
										{#if keycapIndex > 0}<span>+</span>{/if}
										<span class="composer-hotkey-keycap">{keycap}</span>
									{/each}
									<span>{$i18n.t('queue')}</span>
								</div>
							{/if}
							{#if atSelectedModel !== undefined}
								<div inert={nativeInputInteractionLocked} class="px-3 pt-3 text-left w-full flex flex-col z-10">
									<div class="flex items-center justify-between w-full">
										<div class="pl-[1px] flex items-center gap-2 text-sm dark:text-gray-500">
											{#if atSelectedModelLogoSources.dark}
												<img
													alt="model profile"
													class="size-3.5 max-w-[28px] rounded-full object-cover dark:hidden {usesCelestialModelLogo(atSelectedModelRecord) ? 'celestial-model-logo' : ''}"
													src={atSelectedModelLogoSources.light}
												/>
												<img
													alt="model profile"
													class="hidden size-3.5 max-w-[28px] rounded-full object-cover dark:block {usesCelestialModelLogo(atSelectedModelRecord) ? 'celestial-model-logo' : ''}"
													src={atSelectedModelLogoSources.dark ?? atSelectedModelLogoSources.light}
												/>
											{:else}
												<img
													alt="model profile"
													class="size-3.5 max-w-[28px] object-cover rounded-full {usesCelestialModelLogo(atSelectedModelRecord) ? 'celestial-model-logo' : ''}"
													src={atSelectedModelLogoSources.light}
												/>
											{/if}
											<div class="translate-y-[0.5px]">
												<span class="">{atSelectedModel.name}</span>
											</div>
										</div>
										<div>
											<button
												class="flex items-center dark:text-gray-500"
												on:click={() => {
													atSelectedModel = undefined;
												}}
											>
												<XMark />
											</button>
										</div>
									</div>
								</div>
							{/if}

							{#if files.length > 0}
								<div inert={nativeInputInteractionLocked} class="composer-attachments mx-2 mt-2.5 pb-1.5 flex items-center flex-wrap gap-2.5">
									{#each files as file, fileIdx}
										{#if file.type === 'image' || (file?.content_type ?? '').startsWith('image/')}
											{@const fileUrl =
												file.url.startsWith('data') || file.url.startsWith('http')
													? file.url
													: `${WEBUI_API_BASE_URL}/files/${file.url}${file?.content_type ? '/content' : ''}`}
											<div class="composer-attachment-preview relative group">
												<div class="relative flex items-center">
													<Image
														src={fileUrl}
														alt=""
														imageClassName="composer-attachment-image"
													/>
													{#if atSelectedModel ? visionCapableModels.length === 0 : selectedModels.length !== visionCapableModels.length}
														<Tooltip
															className=" absolute top-1 left-1"
															content={$i18n.t('{{ models }}', {
																models: [...(atSelectedModel ? [atSelectedModel] : selectedModels)]
																	.filter((id) => !visionCapableModels.includes(id))
																	.join(', ')
															})}
														>
															<svg
																xmlns="http://www.w3.org/2000/svg"
																viewBox="0 0 24 24"
																fill="currentColor"
																aria-hidden="true"
																class="size-4 fill-yellow-300"
															>
																<path
																	fill-rule="evenodd"
																	d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003ZM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75Zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"
																	clip-rule="evenodd"
																/>
															</svg>
														</Tooltip>
													{/if}
												</div>
												<div class="composer-attachment-remove-shell absolute -right-2 -top-2">
													<button
														class="composer-attachment-remove outline-hidden focus:outline-hidden"
														type="button"
														aria-label={$i18n.t('Remove file')}
														on:click={() => {
															files.splice(fileIdx, 1);
															files = files;
														}}
													>
														<svg
															xmlns="http://www.w3.org/2000/svg"
															viewBox="0 0 20 20"
															fill="currentColor"
															aria-hidden="true"
															class="size-4"
														>
															<path
																d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
															/>
														</svg>
													</button>
												</div>
											</div>
										{:else}
											<FileItem
												item={file}
												name={file.name}
												type={file.type}
												size={file?.size}
												loading={file.status === 'uploading'}
												dismissible={true}
												edit={true}
												small={true}
												modal={['file', 'collection'].includes(file?.type)}
												on:dismiss={async () => {
													// Remove from UI state
													files.splice(fileIdx, 1);
													files = files;
												}}
												on:click={() => {
													console.log(file);
												}}
											/>
										{/if}
									{/each}
								</div>
							{/if}

							{#if pendingToolConfirmations.length > 0 || pendingSteer || queuedPrompts.length > 0}
								<div inert={nativeInputInteractionLocked} class="mx-2 mt-2.5 flex flex-col gap-2">
									{#if pendingToolConfirmations.length > 0}
										<!-- PORTICO PATCH (N-012 / Round 4 Issue 4): per-action
											 MCP tool-confirmation chips, optionally clustered by
											 (tool_name, mcp) when six or more chips share the
											 same shape (e.g. "delete 100 tasks"). The cluster
											 wrapper offers bulk Approve / Cancel buttons but
											 ONLY after the user expands the cluster and sees
											 the individual entries — preserving per-action
											 visibility while reducing click load. -->
										<ChipClusterGroup
											chips={pendingToolConfirmations}
											chatId={chatId}
											on:decision={onToolConfirmationDecision}
										/>
									{/if}

									{#if pendingSteer}
										<div
											class="rounded-2xl border border-sky-200/80 bg-white/80 px-3 py-2 text-left text-slate-900 transition dark:border-sky-500/20 dark:bg-gray-900/55 dark:text-slate-100"
										>
											<div class="flex items-center justify-between gap-3">
													<div class="min-w-0 flex-1">
														<div class="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
															<span class="text-sky-700 dark:text-sky-200">Pending Steer</span>
															<span class="flex flex-wrap items-center gap-1 normal-case tracking-normal">
																<span>Sends on the next turn</span>
																<span class="inline-flex min-w-5 items-center justify-center rounded-md border border-slate-300/80 bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-white/10 dark:bg-black/20 dark:text-slate-100">
																	↑
																</span>
																<span>to edit pending steer</span>
															</span>
														</div>
													</div>
												<div class="rounded-full border border-sky-200/80 bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-700 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-100">
													1
												</div>
											</div>
											<div class="mt-2">
												<div
													class={`flex items-start gap-3 rounded-xl border border-slate-200/80 bg-slate-50/80 px-3 py-2 transition dark:border-white/10 dark:bg-black/10 ${
														pendingSteer.status === 'editing'
															? 'border-sky-300 bg-sky-50/80 shadow-[0_0_0_1px_rgba(14,165,233,0.14)] dark:bg-sky-500/10'
															: ''
													}`}
												>
													<div class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-700 dark:bg-sky-400/15 dark:text-sky-100">
														S
													</div>
													<div class="min-w-0 flex-1">
														<div class="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
															<span class="text-sky-700 dark:text-sky-200">Pending Steer</span>
															{#if pendingSteer.status === 'editing'}
																<span class="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] tracking-normal text-sky-700 dark:bg-sky-400/15 dark:text-sky-100">
																	Editing
																</span>
															{/if}
														</div>
														<div class="mt-1 truncate text-xs italic text-slate-500 dark:text-slate-400">
															{getPendingWorkPreview(pendingSteer)}
														</div>
														{#if getPendingAttachmentSummary(pendingSteer) && pendingSteer.prompt?.trim()}
															<div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
																{getPendingAttachmentSummary(pendingSteer)}
															</div>
														{/if}
													</div>
													<button
														type="button"
														class="shrink-0 rounded-full p-1 text-slate-400 transition hover:bg-slate-200/80 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-slate-200"
														aria-label={$i18n.t('Cancel pending steer')}
														on:click={() => onCancelPendingSteer()}
													>
														<XMark className="size-4" />
													</button>
												</div>
											</div>
										</div>
									{/if}

									{#if queuedPrompts.length > 0}
										<div class="rounded-2xl border border-sky-200/80 bg-white/80 px-3 py-2 text-left text-slate-900 dark:border-sky-500/20 dark:bg-gray-900/55 dark:text-slate-100">
											<div class="flex items-center justify-between gap-3">
												<div class="min-w-0">
													<div class="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
														<span class="text-sky-700 dark:text-sky-200">Queued Prompts</span>
														<span class="flex flex-wrap items-center gap-1 normal-case tracking-normal">
															<span class="inline-flex min-w-5 items-center justify-center rounded-md border border-slate-300/80 bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-white/10 dark:bg-black/20 dark:text-slate-100">
																{queueEditPreviousKeycaps[0]}
															</span>
															<span class="text-slate-400 dark:text-slate-500">+</span>
															<span class="inline-flex min-w-5 items-center justify-center rounded-md border border-slate-300/80 bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-white/10 dark:bg-black/20 dark:text-slate-100">
																{queueEditPreviousKeycaps[1]}
															</span>
															<span class="text-slate-400 dark:text-slate-500">/</span>
															<span class="inline-flex min-w-5 items-center justify-center rounded-md border border-slate-300/80 bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-white/10 dark:bg-black/20 dark:text-slate-100">
																{queueEditNextKeycaps[1]}
															</span>
															<span>to edit queued prompts</span>
														</span>
													</div>
												</div>
												<div class="rounded-full border border-sky-200/80 bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-700 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-100">
													{queuedPrompts.length}
												</div>
											</div>
											<div class="mt-2 flex flex-col gap-2">
												{#each queuedPrompts as queuedPrompt, queuedPromptIndex (queuedPrompt.id)}
													<div
														class={`flex items-start gap-3 rounded-xl border border-slate-200/80 bg-slate-50/80 px-3 py-2 transition dark:border-white/10 dark:bg-black/10 ${
															queuedPrompt.status === 'editing'
																? 'border-sky-300 bg-sky-50/80 shadow-[0_0_0_1px_rgba(14,165,233,0.14)] dark:bg-sky-500/10'
																: ''
														}`}
													>
														<div class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[10px] font-semibold text-sky-700 dark:bg-sky-400/15 dark:text-sky-100">
															{queuedPromptIndex + 1}
														</div>
														<div class="min-w-0 flex-1">
															<div class="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
																<span class="text-sky-700 dark:text-sky-200">Queued Prompt</span>
																{#if queuedPrompt.status === 'editing'}
																	<span class="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] tracking-normal text-sky-700 dark:bg-sky-400/15 dark:text-sky-100">
																		Editing
																	</span>
																{/if}
															</div>
															<div class="mt-1 truncate text-xs italic text-slate-500 dark:text-slate-400">
																{getPendingWorkPreview(queuedPrompt)}
															</div>
															{#if getPendingAttachmentSummary(queuedPrompt) && queuedPrompt.prompt?.trim()}
																<div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
																	{getPendingAttachmentSummary(queuedPrompt)}
																</div>
															{/if}
														</div>
														<button
															type="button"
															class="shrink-0 rounded-full p-1 text-slate-400 transition hover:bg-slate-200/80 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-slate-200"
															aria-label={$i18n.t('Cancel queued prompt')}
															on:click={() => onCancelQueuedPrompt(queuedPrompt.id)}
														>
															<XMark className="size-4" />
														</button>
													</div>
												{/each}
											</div>
										</div>
									{/if}
								</div>
							{/if}

							{#if !readOnlyMode}
							<div inert={nativeInputInteractionLocked} class="px-2.5">
								<div
									class="scrollbar-hidden rtl:text-right ltr:text-left bg-transparent dark:text-gray-100 outline-hidden w-full pb-0.5 px-1 resize-none h-fit max-h-96 overflow-auto {files.length ===
									0
										? atSelectedModel !== undefined
											? 'pt-1.5'
											: 'pt-2.5'
										: ''}"
									id="chat-input-container"
									style:min-height={readOnlyMode ? undefined : '5.25rem'}
								>
									{#if suggestions}
										{#key $settings?.richTextInput ?? true}
											{#key $settings?.showFormattingToolbar ?? false}
												<RichTextInput
													bind:this={chatInputElement}
													id="chat-input"
													onChange={(e) => {
														prompt = e.md;
														command = getCommand();
													}}
													json={true}
													richText={$settings?.richTextInput ?? true}
													messageInput={true}
													showFormattingToolbar={$settings?.showFormattingToolbar ?? false}
													floatingMenuPlacement={'top-start'}
													insertPromptAsRichText={$settings?.insertPromptAsRichText ?? false}
													shiftEnter={!($settings?.ctrlEnterToSend ?? false) &&
														!$mobile &&
														!(
															'ontouchstart' in window ||
															navigator.maxTouchPoints > 0 ||
															navigator.msMaxTouchPoints > 0
														)}
													placeholder={placeholder
														? placeholder
														: crossPaneTargetLabel
															? $i18n.t('Message {{name}}', { name: crossPaneTargetLabel })
															: $i18n.t('Send a Message')}
													largeTextAsFile={($settings?.largeTextAsFile ?? false) && !shiftKey}
													autocomplete={$config?.features?.enable_autocomplete_generation &&
														($settings?.promptAutocomplete ?? false)}
													generateAutoCompletion={async (text) => {
														if (selectedModelIds.length === 0 || !selectedModelIds.at(0)) {
															toast.error($i18n.t('Please select a model first.'));
														}

														const autocompleteMessages = getAutocompleteMessages?.() ?? null;
														const res = await generateAutoCompletion(
															localStorage.token,
															selectedModelIds.at(0),
															text,
															autocompleteMessages
														).catch((error) => {
															console.log(error);

															return null;
														});

														console.log(res);
														return res;
													}}
													{suggestions}
													oncompositionstart={() => (isComposing = true)}
													oncompositionend={(e) => {
														compositionEndedAt = e.timeStamp;
														isComposing = false;
													}}
													on:keydown={async (e) => {
														e = e.detail.event;

														const isCtrlPressed = e.ctrlKey || e.metaKey; // metaKey is for Cmd key on Mac
														const suggestionsContainerElement =
															document.getElementById('suggestions-container');
														const hotkeyAction = resolveComposerHotkeyAction({
															key: e.key,
															altKey: e.altKey,
															shiftKey: e.shiftKey,
															isStreaming,
															prompt,
															hasFiles: files.length > 0,
															hasPendingSteer: Boolean(pendingSteer),
															queuedPromptCount: queuedPrompts.length,
															pendingWorkEditMode
														});

														if (hotkeyAction === 'cancel-pending-work-edit') {
															e.preventDefault();
															await onCancelPendingWorkEdit();
															return;
														}

														if (hotkeyAction === 'stop') {
															e.preventDefault();
															stopResponse();
															return;
														}

														if (
															!suggestionsContainerElement &&
															(hotkeyAction === 'restore-steer' ||
																hotkeyAction === 'restore-queue-previous' ||
																hotkeyAction === 'restore-queue-next')
														) {
															e.preventDefault();
															if (hotkeyAction === 'restore-steer') {
																await onRestorePendingSteer();
															} else {
																await onRestoreQueuedPrompt(
																	hotkeyAction === 'restore-queue-next' ? 'next' : 'previous'
																);
															}
															return;
														}

														if (!suggestionsContainerElement) {
															if (
																!$mobile ||
																!(
																	'ontouchstart' in window ||
																	navigator.maxTouchPoints > 0 ||
																	navigator.msMaxTouchPoints > 0
																)
															) {
																if (inOrNearComposition(e)) {
																	return;
																}

																if (hotkeyAction === 'submit-steer') {
																	e.preventDefault();
																	if (
																		pendingWorkEditMode !== 'none' ||
																		prompt !== '' ||
																		files.length > 0
																	) {
																		await onSubmitPendingSteer();
																	}
																	return;
																}

																if (hotkeyAction === 'submit-queue') {
																	e.preventDefault();
																	if (
																		pendingWorkEditMode !== 'none' ||
																		prompt !== '' ||
																		files.length > 0
																	) {
																		await onSubmitQueuedPrompt();
																	}
																	return;
																}

																// Uses keyCode '13' for Enter key for chinese/japanese keyboards.
																//
																// Depending on the user's settings, it will send the message
																// either when Enter is pressed or when Ctrl+Enter is pressed.
																const enterPressed =
																	($settings?.ctrlEnterToSend ?? false)
																		? (e.key === 'Enter' || e.keyCode === 13) && isCtrlPressed
																		: (e.key === 'Enter' || e.keyCode === 13) && !e.shiftKey;

																if (enterPressed) {
																	e.preventDefault();
																	if (prompt !== '' || files.length > 0) {
																		dispatch('submit', prompt);
																	}
																}
															}
														}
													}}
													on:paste={async (e) => {
														e = e.detail.event;
														console.log(e);

														const clipboardData = e.clipboardData || window.clipboardData;

														if (clipboardData && clipboardData.items) {
															for (const item of clipboardData.items) {
																if (item.type.indexOf('image') !== -1) {
																	const blob = item.getAsFile();
																	const reader = new FileReader();

																	reader.onload = function (e) {
																		files = [
																			...files,
																			{
																				type: 'image',
																				url: `${e.target.result}`
																			}
																		];
																	};

																	reader.readAsDataURL(blob);
																} else if (item?.kind === 'file') {
																	const file = item.getAsFile();
																	if (file) {
																		const _files = [file];
																		await inputFilesHandler(_files);
																		e.preventDefault();
																	}
																} else if (item.type === 'text/plain') {
																	if (($settings?.largeTextAsFile ?? false) && !shiftKey) {
																		const text = clipboardData.getData('text/plain');

																		if (text.length > PASTED_TEXT_CHARACTER_LIMIT) {
																			e.preventDefault();
																			const blob = new Blob([text], { type: 'text/plain' });
																			const file = new File(
																				[blob],
																				`Pasted_Text_${Date.now()}.txt`,
																				{
																					type: 'text/plain'
																				}
																			);

																			await uploadFileHandler(file, true, { context: 'full' });
																		}
																	}
																}
															}
														}
													}}
												/>
											{/key}
										{/key}
									{/if}
								</div>
							</div>
							{/if}

								<div
									class="flex max-w-full {readOnlyMode
										? 'subagent-badge-row mt-0 mb-0 mx-0'
										: 'items-center justify-between gap-1 mt-0 mb-1.5 mx-0'}"
									dir="ltr"
								>
									<div
										inert={nativeInputInteractionLocked}
										class="capability-row {readOnlyMode
											? 'flex flex-wrap items-center justify-center max-w-full'
											: 'ml-0 self-center flex flex-wrap items-center flex-1 min-w-0 max-w-full'}"
									>
									{#if !readOnlyMode}
									<InputMenu
										bind:files
										selectedModels={atSelectedModel ? [atSelectedModel.id] : selectedModels}
										{fileUploadCapableModels}
										{screenCaptureHandler}
										{inputFilesHandler}
										uploadFilesHandler={() => {
											filesInputElement.click();
										}}
										uploadGoogleDriveHandler={async () => {
											try {
												const fileData = await createPicker();
												if (fileData) {
													const file = new File([fileData.blob], fileData.name, {
														type: fileData.blob.type
													});
													await uploadFileHandler(file);
												} else {
													console.log('No file was selected from Google Drive');
												}
											} catch (error) {
												console.error('Google Drive Error:', error);
												toast.error(
													$i18n.t('Error accessing Google Drive: {{error}}', {
														error: error.message
													})
												);
											}
										}}
										uploadOneDriveHandler={async (authorityType) => {
											try {
												const fileData = await pickAndDownloadFile(authorityType);
												if (fileData) {
													const file = new File([fileData.blob], fileData.name, {
														type: fileData.blob.type || 'application/octet-stream'
													});
													await uploadFileHandler(file);
												} else {
													console.log('No file was selected from OneDrive');
												}
											} catch (error) {
												console.error('OneDrive Error:', error);
											}
										}}
										{onUpload}
										onClose={async () => {
											await tick();

											const chatInput = document.getElementById('chat-input');
											chatInput?.focus();
										}}
										>
												<div
													id="input-menu-button"
													class="relative bg-transparent text-slate-700 hover:bg-slate-200/85 dark:text-white dark:hover:bg-gray-800 rounded-full h-8 flex items-center justify-center outline-hidden focus:outline-hidden"
												>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2.5"
													stroke-linecap="round"
													class="size-5"
													aria-hidden="true"
												>
													<path d="M12 5v14M5 12h14" />
												</svg>
											</div>
									</InputMenu>
									{/if}

									{#if !readOnlyMode}
										<Tooltip
											content={selectedWorkspaceDisplayPath || $i18n.t('Select folder to work in...')}
											placement="top"
										>
											{#if selectedWorkspaceDisplayPath}
												<div
													class="workspace-folder-badge capability-pill capability-pill--interactive -ml-0.5 max-w-[min(18rem,calc(100vw-5rem))] shrink-0 overflow-hidden"
													role="button"
													tabindex="0"
													on:click={handleWorkspaceBadgeClick}
													on:keydown={handleWorkspaceBadgeKeydown}
												>
													<span class="mr-0.5 flex shrink-0 items-center justify-center">
														<FolderOpen className="size-5" />
													</span>
													<span class="min-w-0 max-w-[13rem] truncate text-xs">
														{selectedWorkspaceDisplayPath}
													</span>
													{#if workspaceSelectionApplying}
														<span
															class="workspace-folder-spinner ml-1 flex size-4 shrink-0 items-center justify-center rounded-full text-slate-500 dark:text-gray-300"
															aria-label={$i18n.t('Applying workspace folder')}
														>
															<span
																class="size-3 animate-spin rounded-full border-[1.5px] border-current border-r-transparent"
																aria-hidden="true"
															></span>
														</span>
													{:else}
														<button
															type="button"
															aria-label={$i18n.t('Use default workspace folder')}
															disabled={workspaceBusy}
															class="ml-1 flex size-4 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-200/80 hover:text-slate-800 disabled:pointer-events-none disabled:opacity-70 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white"
															on:click|stopPropagation|preventDefault={clearChatWorkspaceFolder}
														>
															<XMark className="size-3" strokeWidth="2" />
														</button>
													{/if}
												</div>
											{:else}
												<button
													type="button"
													aria-label={$i18n.t('Choose workspace folder')}
													disabled={workspaceBusy || (!chatId && typeof ensureChatId !== 'function')}
													class="workspace-folder-badge -ml-1.5 flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-transparent text-slate-700 outline-hidden hover:bg-slate-200/85 focus:outline-hidden disabled:opacity-50 dark:text-white dark:hover:bg-gray-800"
													on:click={selectChatWorkspaceFolder}
												>
													{#if workspaceOperation === 'picking'}
														<span
															class="size-4 animate-spin rounded-full border-[1.5px] border-current border-r-transparent"
															aria-hidden="true"
														></span>
													{:else}
														<FolderOpen className="size-5" />
													{/if}
												</button>
											{/if}
										</Tooltip>
									{/if}

									{#if readOnlyMode && readOnlyWorkspaceBadgeLabel}
										<Tooltip content={readOnlyWorkspaceTooltip || readOnlyWorkspaceBadgeLabel} placement="top">
											<div
												class="workspace-folder-badge capability-pill capability-pill--readonly max-w-[min(18rem,calc(100vw-5rem))] shrink-0 overflow-hidden whitespace-nowrap select-none"
											>
												<span class="mr-0.5 flex shrink-0 items-center justify-center">
													<FolderOpen className="size-4" />
												</span>
												<span class="min-w-0 max-w-[13rem] truncate text-xs">
													{readOnlyWorkspaceBadgeLabel}
												</span>
											</div>
										</Tooltip>
									{/if}

									{#if (!readOnlyMode && atSelectedModel === undefined) || reasoningCapableModels.length > 0}
									<!-- Right rail: reviewer pill + intelligence capsule form ONE
									     non-wrapping unit with the right-pushing margin, so a tight
									     row (e.g. a workspace badge) wraps the whole rail together
									     and keeps it right-aligned — never a stranded capsule. -->
									<div class="composer-intelligence-rail">
										{#if !readOnlyMode && atSelectedModel === undefined}
											<!-- PORTICO PATCH (reviewer workflow): standalone critic pill,
											     detached from the model/effort capsule. Armed only before
											     the chat's first prompt; locked read-only afterwards. The
											     CTA callout renders on the landing composer only. -->
											<div class="composer-reviewer-workflow-control" data-composer-reviewer-workflow>
												<ReviewerWorkflowToggle
													enabled={reviewerWorkflowEnabled}
													locked={reviewerWorkflowLocked}
													showIntro={reviewerWorkflowIntroVisible && !reviewerWorkflowLocked}
													introRemaining={reviewerWorkflowIntroRemaining}
													onToggle={onReviewerWorkflowToggle}
													onDismissIntro={onReviewerWorkflowIntroDismiss}
												/>
											</div>
										{/if}
										<div class="composer-intelligence-control composer-rail-control-surface" data-composer-intelligence-control>
											{#if !readOnlyMode && atSelectedModel === undefined && fastModeEligible}
												<!-- PORTICO PATCH (fast mode): lightning toggle, left of the model picker -->
												<div class="composer-fast-mode-control">
													<FastModeToggle enabled={fastModeEnabled} onToggle={onFastModeToggle} />
												</div>
											{/if}
											{#if !readOnlyMode && atSelectedModel === undefined}
												<ModelSelector bind:selectedModels compact={true} />
											{/if}
											{#each reasoningCapableModels as model (model.index)}
												<div class="composer-reasoning-control">
													<ReasoningEffortControl
														{model}
														modelCount={reasoningCapableModels.length}
														{reasoningEffortByModel}
														{readOnlyMode}
														onSelect={onReasoningEffortSelect}
													/>
												</div>
											{/each}
										</div>
									</div>
									{/if}

									{#if false}
										<!-- Legacy discrete menu retained as unreachable markup during the slider migration. -->
										<!-- PORTICO PATCH: Per-model Reasoning Effort Pills with Dropdown (bits-ui) -->
									<!-- Use model.index as key to support duplicate models (same model added twice) -->
									{#each reasoningCapableModels as model (model.index)}
										{@const modelKey = String(model.index)}
										{@const allOptions = [
											{ value: 'none', label: 'None', iconClass: 'text-gray-400' },
											{ value: 'low', label: 'Low', iconClass: 'text-emerald-500' },
											{ value: 'medium', label: 'Medium', iconClass: 'text-blue-500' },
											{ value: 'high', label: 'High', iconClass: 'text-purple-500' },
											{ value: 'xhigh', label: 'XHigh', iconClass: 'text-fuchsia-500' },
											{ value: 'max', label: 'Max', iconClass: 'text-rose-500' },
											{ value: 'ultra', label: 'Ultra', iconClass: 'text-amber-500' }
										]}
										{@const availableOptions = allOptions.filter(opt => model.options.includes(opt.value))}
										{@const currentEffort = resolveReasoningEffortByModelEntry({
											reasoningEffortByModel,
											modelIndex: model.index,
											allowedOptions: model.options
										}) ?? model.options[0]}
										{@const currentOption = availableOptions.find(opt => opt.value === currentEffort) ?? availableOptions[0]}
										<Tooltip content={reasoningCapableModels.length > 1
											? (model.baseModelName ? `${model.name} (${model.baseModelName}) - Reasoning` : `${model.name} - Reasoning Effort`)
											: (model.baseModelName ? `Reasoning Effort (${model.baseModelName})` : $i18n.t('Reasoning Effort'))} placement="top">
											{#if readOnlyMode}
												<div
													id="reasoning-effort-button-{model.index}"
													class="capability-pill shrink-0 whitespace-nowrap select-none"
												>
													<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"
														class="size-3.5 {currentOption?.iconClass ?? 'text-emerald-500'}">
														<path fill-rule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813A3.75 3.75 0 007.466 7.89l.813-2.846A.75.75 0 019 4.5zM18 1.5a.75.75 0 01.728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 010 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 01-1.456 0l-.258-1.036a2.625 2.625 0 00-1.91-1.91l-1.036-.258a.75.75 0 010-1.456l1.036-.258a2.625 2.625 0 001.91-1.91l.258-1.036A.75.75 0 0118 1.5zM16.5 15a.75.75 0 01.712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 010 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 01-1.422 0l-.395-1.183a1.5 1.5 0 00-.948-.948l-1.183-.395a.75.75 0 010-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0116.5 15z" clip-rule="evenodd"/>
													</svg>
													<span>{currentOption?.label ?? currentEffort}</span>
												</div>
											{:else}
												<Dropdown side="bottom" align="start">
													<button
														type="button"
														id="reasoning-effort-button-{model.index}"
														class="capability-pill capability-pill--interactive relative -top-px shrink-0 whitespace-nowrap outline-none focus:outline-none"
													>
														<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"
															class="size-3.5 {currentOption?.iconClass ?? 'text-emerald-500'}">
															<path fill-rule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813A3.75 3.75 0 007.466 7.89l.813-2.846A.75.75 0 019 4.5zM18 1.5a.75.75 0 01.728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 010 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 01-1.456 0l-.258-1.036a2.625 2.625 0 00-1.91-1.91l-1.036-.258a.75.75 0 010-1.456l1.036-.258a2.625 2.625 0 001.91-1.91l.258-1.036A.75.75 0 0118 1.5zM16.5 15a.75.75 0 01.712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 010 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 01-1.422 0l-.395-1.183a1.5 1.5 0 00-.948-.948l-1.183-.395a.75.75 0 010-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0116.5 15z" clip-rule="evenodd"/>
														</svg>
														<span>{currentOption?.label ?? currentEffort}</span>
													</button>

													<div slot="content">
													<DropdownMenu.Content
														class="portico-menu-surface w-full max-w-48"
														sideOffset={4}
														side="bottom"
														align="start"
														collisionPadding={12}
														transition={flyAndScale}
														>
															{#if reasoningCapableModels.length > 1}
																<div class="mb-1 truncate border-b border-slate-300/70 px-3 py-1.5 text-xs text-slate-500 dark:border-gray-700 dark:text-gray-400 max-w-[180px]">
																	{model.name}
																</div>
															{/if}
															{#each availableOptions as option}
														<DropdownMenu.Item
															class="portico-menu-item"
																	on:click={() => {
																		onReasoningEffortSelect({
																			modelIndex: model.index,
																			value: option.value
																		});
																	}}
																>
																	<svg
																		xmlns="http://www.w3.org/2000/svg"
																		viewBox="0 0 24 24"
																		fill="currentColor"
																		class="size-4 shrink-0 {option.iconClass}"
																	>
																		<path fill-rule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813A3.75 3.75 0 007.466 7.89l.813-2.846A.75.75 0 019 4.5zM18 1.5a.75.75 0 01.728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 010 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 01-1.456 0l-.258-1.036a2.625 2.625 0 00-1.91-1.91l-1.036-.258a.75.75 0 010-1.456l1.036-.258a2.625 2.625 0 001.91-1.91l.258-1.036A.75.75 0 0118 1.5zM16.5 15a.75.75 0 01.712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 010 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 01-1.422 0l-.395-1.183a1.5 1.5 0 00-.948-.948l-1.183-.395a.75.75 0 010-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0116.5 15z" clip-rule="evenodd"/>
																	</svg>
																	<div class="flex min-w-0 flex-1 items-center text-gray-800 dark:text-gray-100">
																		<span>{option.label}</span>
																	</div>
																	{#if currentEffort === option.value}
																		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="ml-2 size-4 shrink-0 text-gray-600 dark:text-gray-300">
																			<path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd"/>
																		</svg>
																	{/if}
																</DropdownMenu.Item>
															{/each}
														</DropdownMenu.Content>
													</div>
												</Dropdown>
											{/if}
										</Tooltip>
										{/each}
									{/if}

										<div class="composer-active-capabilities flex shrink-0 items-center">
											<ActiveCapabilities
												tools={[]}
												skills={[]}
												{artifacts}
											/>
										</div>

										{#if !readOnlyMode && selectedModelIds.length === 1 && $models.find((m) => m.id === selectedModelIds[0])?.has_user_valves}
											<div class="shrink-0 flex gap-1.5">
											<Tooltip content={$i18n.t('Valves')} placement="top">
												<button
													type="button"
													id="model-valves-button"
													class="bg-transparent hover:bg-slate-200/85 text-slate-700 dark:text-white dark:hover:bg-gray-800 rounded-full size-8 flex justify-center items-center outline-hidden focus:outline-hidden"
													on:click={() => {
														selectedValvesType = 'function';
														selectedValvesItemId = selectedModelIds[0]?.split('.')[0];
														showValvesModal = true;
													}}
												>
													<Knobs className="size-4" strokeWidth="1.5" />
												</button>
											</Tooltip>
										</div>
									{/if}

									<!-- PORTICO PATCH: Removed tools icon (wrench with count) -->
									{#if !readOnlyMode}
									<div class="ml-1 flex gap-1.5">
										{#each selectedFilterIds as filterId}
											{@const filter = toggleFilters.find((f) => f.id === filterId)}
											{#if filter}
												<Tooltip content={filter?.name} placement="top">
													<button
														on:click|preventDefault={() => {
															selectedFilterIds = selectedFilterIds.filter((id) => id !== filterId);
														}}
														type="button"
														class="group p-[7px] flex gap-1.5 items-center text-sm rounded-full transition-colors duration-300 focus:outline-hidden max-w-full overflow-hidden {selectedFilterIds.includes(
															filterId
														)
															? 'text-sky-500 dark:text-sky-300 bg-sky-50 hover:bg-sky-100 dark:bg-sky-400/10 dark:hover:bg-sky-600/10 border border-sky-200/40 dark:border-sky-500/20'
															: 'bg-transparent text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 '} capitalize"
													>
														{#if filter?.icon}
															<div class="size-4 items-center flex justify-center">
																<img
																	src={filter.icon}
																	class="size-3.5 {filter.icon.includes('svg')
																		? 'dark:invert-[80%]'
																		: ''}"
																	style="fill: currentColor;"
																	alt={filter.name}
																/>
															</div>
														{:else}
															<Sparkles className="size-4" strokeWidth="1.75" />
														{/if}
														<div class="hidden group-hover:block">
															<XMark className="size-4" strokeWidth="1.75" />
														</div>
													</button>
												</Tooltip>
											{/if}
										{/each}

										{#if webSearchEnabled}
											<Tooltip content={$i18n.t('Web Search')} placement="top">
												<button
													on:click|preventDefault={() => (webSearchEnabled = !webSearchEnabled)}
													type="button"
													class="group p-[7px] flex gap-1.5 items-center text-sm rounded-full transition-colors duration-300 focus:outline-hidden max-w-full overflow-hidden {webSearchEnabled ||
													($settings?.webSearch ?? false) === 'always'
														? ' text-sky-500 dark:text-sky-300 bg-sky-50 hover:bg-sky-100 dark:bg-sky-400/10 dark:hover:bg-sky-600/10 border border-sky-200/40 dark:border-sky-500/20'
														: 'bg-transparent text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 '}"
												>
													<GlobeAlt className="size-4" strokeWidth="1.75" />
													<div class="hidden group-hover:block">
														<XMark className="size-4" strokeWidth="1.75" />
													</div>
												</button>
											</Tooltip>
										{/if}

										{#if imageGenerationEnabled}
											<Tooltip content={$i18n.t('Image')} placement="top">
												<button
													on:click|preventDefault={() =>
														(imageGenerationEnabled = !imageGenerationEnabled)}
													type="button"
													class="group p-[7px] flex gap-1.5 items-center text-sm rounded-full transition-colors duration-300 focus:outline-hidden max-w-full overflow-hidden {imageGenerationEnabled
														? ' text-sky-500 dark:text-sky-300 bg-sky-50 hover:bg-sky-100 dark:bg-sky-400/10 dark:hover:bg-sky-700/10 border border-sky-200/40 dark:border-sky-500/20'
														: 'bg-transparent text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 '}"
												>
													<Photo className="size-4" strokeWidth="1.75" />
													<div class="hidden group-hover:block">
														<XMark className="size-4" strokeWidth="1.75" />
													</div>
												</button>
											</Tooltip>
										{/if}

										{#if codeInterpreterEnabled}
											<Tooltip content={$i18n.t('Code Interpreter')} placement="top">
												<button
													aria-label={codeInterpreterEnabled
														? $i18n.t('Disable Code Interpreter')
														: $i18n.t('Enable Code Interpreter')}
													aria-pressed={codeInterpreterEnabled}
													on:click|preventDefault={() =>
														(codeInterpreterEnabled = !codeInterpreterEnabled)}
													type="button"
													class=" group p-[7px] flex gap-1.5 items-center text-sm transition-colors duration-300 max-w-full overflow-hidden {codeInterpreterEnabled
														? ' text-sky-500 dark:text-sky-300 bg-sky-50 hover:bg-sky-100 dark:bg-sky-400/10 dark:hover:bg-sky-700/10 border border-sky-200/40 dark:border-sky-500/20'
														: 'bg-transparent text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 '} {($settings?.highContrastMode ??
													false)
														? 'm-1'
														: 'focus:outline-hidden rounded-full'}"
												>
													<Terminal className="size-3.5" strokeWidth="2" />

													<div class="hidden group-hover:block">
														<XMark className="size-4" strokeWidth="1.75" />
													</div>
												</button>
											</Tooltip>
										{/if}
									</div>
									{/if}
								</div>

								<div class="composer-metrics-row {readOnlyMode ? 'self-center' : 'ml-auto self-center'} flex shrink-0 items-center gap-1">
									<ComposerMetrics
										capabilities={activeCapabilities}
										costLabel={formatCost(aggregateCost)}
										costWithoutCacheLabel={formatCost(aggregateCostWithoutCache)}
										cacheSavingsLabel={`${aggregateCacheSavings < 0 ? '-' : ''}${formatCost(Math.abs(aggregateCacheSavings))}`}
										cacheSavingsTone={aggregateCacheSavingsTone}
										savingsRateLabel={formatPercent(aggregateSavingsRate)}
										cacheReadsLabel={formatTokens(aggregateCacheReadTokens)}
										cacheWritesLabel={formatTokens(aggregateCacheWriteTokens)}
										contextTokensLabel={formatTokens(contextTokens)}
										maxContextTokensLabel={formatTokens(maxContextTokens)}
										{contextPercent}
										{contextPercentLabel}
										remainingContextTokensLabel={formatTokens(remainingContextTokens)}
									/>
								</div>

								{#if !readOnlyMode}
								<div inert={nativeInputInteractionLocked} class="self-center flex space-x-1 mr-1 shrink-0">
									<!-- PORTICO: Removed Dictate (voice input) button -->

									{#if isEditingPendingWork}
										<div class="flex items-center">
											<Tooltip content={pendingWorkPrimaryActionLabel}>
												<button
													id="save-pending-work-button"
													class="{isBlankPendingWorkDraft
														? 'bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-500 dark:text-white dark:hover:bg-rose-400'
														: 'bg-black text-white hover:bg-gray-900 dark:bg-white dark:text-black dark:hover:bg-gray-100'} transition rounded-full px-3 py-1.5 text-sm font-semibold"
													type="submit"
												>
													{pendingWorkPrimaryActionLabel}
												</button>
											</Tooltip>
										</div>
									{:else if isStreaming}
										<div class=" flex items-center">
											<Tooltip content={$i18n.t('Stop')}>
												<button
													class="bg-slate-200 hover:bg-slate-300/80 text-slate-800 dark:bg-gray-700 dark:text-white dark:hover:bg-gray-800 transition rounded-full p-1.5"
													on:click={() => {
														stopResponse();
													}}
												>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														viewBox="0 0 24 24"
														fill="currentColor"
														class="size-5"
													>
														<path
															fill-rule="evenodd"
															d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm6-2.438c0-.724.588-1.312 1.313-1.312h4.874c.725 0 1.313.588 1.313 1.313v4.874c0 .725-.588 1.313-1.313 1.313H9.564a1.312 1.312 0 01-1.313-1.313V9.564z"
															clip-rule="evenodd"
														/>
													</svg>
												</button>
											</Tooltip>
										</div>
									<!-- PORTICO: Removed Voice mode button -->
									{:else}
										<div class=" flex items-center">
											<Tooltip content={$i18n.t('Send message')}>
												<button
													id="send-message-button"
													class="{!(prompt === '' && files.length === 0)
														? 'bg-black text-white hover:bg-gray-900 dark:bg-white dark:text-black dark:hover:bg-gray-100 '
														: 'text-white bg-gray-200 dark:text-gray-900 dark:bg-gray-700 disabled'} transition rounded-full p-1.5 self-center"
													type="submit"
													disabled={prompt === '' && files.length === 0}
												>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														viewBox="0 0 16 16"
														fill="currentColor"
														class="size-5"
													>
														<path
															fill-rule="evenodd"
															d="M8 14a.75.75 0 0 1-.75-.75V4.56L4.03 7.78a.75.75 0 0 1-1.06-1.06l4.5-4.5a.75.75 0 0 1 1.06 0l4.5 4.5a.75.75 0 0 1-1.06 1.06L8.75 4.56v8.69A.75.75 0 0 1 8 14Z"
															clip-rule="evenodd"
														/>
													</svg>
												</button>
											</Tooltip>
										</div>
									{/if}
								</div>
								{/if}
							</div>
							</div>
						</div>

							{#if $config?.license_metadata?.input_footer}
							<div class=" text-xs text-gray-500 text-center line-clamp-1 marked">
								{@html DOMPurify.sanitize(marked($config?.license_metadata?.input_footer))}
							</div>
						{:else}
							<div class="mb-1"></div>
						{/if}
					</form>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.cross-pane-target-chip {
		background: var(--badge-bg);
		color: var(--badge-text);
		border-color: var(--badge-border);
	}
	:global(.dark) .cross-pane-target-chip {
		background: var(--badge-bg-dark);
		color: var(--badge-text-dark);
		border-color: var(--badge-border-dark);
	}

	.question-attention-bar {
		animation: question-attention-pulse 1.8s ease-in-out infinite;
	}

	@keyframes question-attention-pulse {
		0%,
		100% {
			box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.08);
		}
		50% {
			box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.16);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.question-attention-bar {
			animation: none;
			box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.14);
		}
	}
</style>
