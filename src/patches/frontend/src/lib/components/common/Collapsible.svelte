<script lang="ts">
	import { decode } from 'html-entities';
	import { v4 as uuidv4 } from 'uuid';
	import { page } from '$app/stores';

	import { getContext, onDestroy, tick } from 'svelte';
	import { readable, type Readable } from 'svelte/store';
	const i18n = getContext('i18n');

	import dayjs from '$lib/dayjs';
	import duration from 'dayjs/plugin/duration';
	import relativeTime from 'dayjs/plugin/relativeTime';

	dayjs.extend(duration);
	dayjs.extend(relativeTime);

	async function loadLocale(locales) {
		if (!locales || !Array.isArray(locales)) {
			return;
		}
		for (const locale of locales) {
			try {
				dayjs.locale(locale);
				break; // Stop after successfully loading the first available locale
			} catch (error) {
				console.error(`Could not load locale '${locale}':`, error);
			}
		}
	}

	// Assuming $i18n.languages is an array of language codes
	$: loadLocale($i18n.languages);

	import { slide } from 'svelte/transition';
	import { quintOut } from 'svelte/easing';

	import { shouldShowThoughtDuration } from '$lib/utils/reasoningMarkup';
	import ChevronUp from '../icons/ChevronUp.svelte';
	import ChevronDown from '../icons/ChevronDown.svelte';
	import Spinner from './Spinner.svelte';
	import CodeBlock from '../chat/Messages/CodeBlock.svelte';
	import Markdown from '../chat/Messages/Markdown.svelte';
	import FullHeightIframe from './FullHeightIframe.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import { settings } from '$lib/stores';
	import { isDarkMode } from '$lib/stores/isDarkMode';
	import { ensureMcpServerIdForToolName, mcpServerIds } from '$lib/stores/mcpServerIds';
	import {
		extractServerIdFromToolName,
		formatToolDisplayName,
		looksLikeMcpToolName
	} from '$lib/utils/mcpServerIdRegistry';
	import { getDisplayTokenCountFromUsage } from '$lib/utils/usage-tokens.mjs';
	import { resolveSubagentDisplayTokenCount } from '$lib/utils/subagent-tokens.mjs';
	import { extractSubagentResultStats } from '$lib/utils/subagent-result-stats.mjs';
	import {
		resolveSubagentToolCallDetail,
		SUBAGENT_DETAILS_CONTEXT,
		type SubagentToolCallDetails
	} from '$lib/utils/subagentDetails';
	import {
		resolveSubagentLookupResult,
		resolveSubagentPollingMode
	} from '$lib/utils/subagent-polling-mode.mjs';
	import { getChatState } from '$lib/apis/chatState';
	import { copyToClipboard } from '$lib/utils';
	import { toast } from 'svelte-sonner';
	import { isWorkActivityType } from '$lib/utils/work-activity-summary.mjs';

	const subagentDetailsStore =
		getContext<Readable<SubagentToolCallDetails>>(SUBAGENT_DETAILS_CONTEXT) ??
		readable<SubagentToolCallDetails>({});

	export let open = false;

	export let className = '';
	export let buttonClassName =
		'w-fit text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition';

	export let id = '';
	export let title = null;
	export let attributes = null;
	export let messageDone: boolean | null = null;
	export let messageStopReason: string | null = null;
	export let dir: string | undefined = undefined;
	export let copyText: string | null = null;

	export let chevron = false;
	export let grow = false;

	export let disabled = false;
	export let hide = false;

	export let onChange: Function = () => {};
	export let onStopResponse: Function = () => {};

	$: onChange(open);

	const collapsibleId = uuidv4();

	// Delay rendering heavy content until after animation starts
	let shouldRenderContent = false;
	$: if (open) {
		// Defer rendering to next frame to let animation start smoothly
		requestAnimationFrame(() => {
			tick().then(() => {
				shouldRenderContent = true;
			});
		});
	} else {
		shouldRenderContent = false;
	}

	function toggleOpen(event?: MouseEvent) {
		if (disabled) {
			return;
		}
		open = !open;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (disabled) {
			return;
		}
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			open = !open;
		}
	}

	// Client-side timer for real-time elapsed time updates
	let clientElapsed = 0;
	let lastClientElapsed = 0;
	let displayElapsed = 0;
	let displayDuration = 0;
	let timerInterval: ReturnType<typeof setInterval> | null = null;
	let lastStartedAt: number | null = null;
	let lastBackendElapsed: number | null = null;
	let timerStartMs: number | null = null; // When the client timer started
	let reasoningTimerKey: string | null = null;

	let subagentChatId: string | null = null;
	let subagentToolCallId: string | null = null;
	let subagentToolCalls: number | null = null;
	let subagentTokens: number | null = null;
	let subagentUsageTokens: number | null = null;
	let toolCallsPulse = false;
	let tokensPulse = false;
	let toolCallsPulseTimer: ReturnType<typeof setTimeout> | null = null;
	let tokensPulseTimer: ReturnType<typeof setTimeout> | null = null;
	let showSubagentToolCalls = false;
	let showSubagentTokens = false;
	let subagentToolCallsLabel = '';
	let subagentTokensLabel = '';
	let subagentPolling: ReturnType<typeof setInterval> | null = null;
	let subagentPollingMode: 'foreground' | 'background' | null = null;
	let subagentVisibilityHandler: (() => void) | null = null;
	let subagentStatsLoading = false;
	let subagentLookupLoading = false;
	let subagentFinalizedToolCallId: string | null = null;
	let subagentChatTerminal = false;
	let subagentResultStats: ReturnType<typeof extractSubagentResultStats> | null = null;
	const SUBAGENT_POLL_INTERVAL_MS = 2000;
	const SUBAGENT_BACKGROUND_POLL_INTERVAL_MS = 10000;

	const clearReasoningTimerInterval = () => {
		if (timerInterval) {
			clearInterval(timerInterval);
			timerInterval = null;
		}
	};

	const resetReasoningTimerState = (resetElapsed = true) => {
		clearReasoningTimerInterval();
		lastStartedAt = null;
		lastBackendElapsed = null;
		timerStartMs = null;
		if (resetElapsed) {
			clientElapsed = 0;
			lastClientElapsed = 0;
		}
	};

	const getReasoningTimerKey = (nextAttributes: Record<string, unknown> | null): string | null => {
		const type = String(nextAttributes?.['type'] ?? '')
			.trim()
			.toLowerCase();
		if (type !== 'reasoning') return null;

		const idValue = String(nextAttributes?.['id'] ?? '').trim();
		const startedAtValue = String(nextAttributes?.['started_at'] ?? '').trim();
		if (idValue || startedAtValue) {
			return `${idValue}|${startedAtValue}`;
		}

		// Fallback for malformed payloads without id/started_at.
		return `reasoning:${String(nextAttributes?.['name'] ?? '').trim()}`;
	};

	function getCurrentRouteChatId(): string | null {
		const routeChatId = String($page?.params?.id ?? '').trim();
		if (routeChatId) {
			return routeChatId;
		}

		const pathMatch = String($page?.url?.pathname ?? '').match(/^\/c\/([^/?#]+)/);
		return pathMatch?.[1] ? decodeURIComponent(pathMatch[1]) : null;
	}

	function buildSubagentDetailsHref(
		chatId: string,
		toolCallId: string | null | undefined = subagentToolCallId
	) {
		const baseHref = `/c/${chatId}`;
		if (typeof window === 'undefined') {
			return baseHref;
		}

		const url = new URL(baseHref, window.location.href);
		url.searchParams.set('subagent-view', '1');
		const parentChatId = getCurrentRouteChatId();
		if (parentChatId) {
			url.searchParams.set('subagent-parent-chat-id', parentChatId);
		}

		const normalizedToolCallId = String(toolCallId ?? '').trim();
		if (normalizedToolCallId) {
			url.searchParams.set('subagent-tool-call-id', normalizedToolCallId);
		}

		return `${url.pathname}${url.search}`;
	}

	async function handleSubagentDetailsClick(
		event: MouseEvent,
		chatId: string | null | undefined,
		toolCallId: string | null | undefined = subagentToolCallId
	) {
		event.stopPropagation();

		if (!chatId) return;

		const href = buildSubagentDetailsHref(chatId, toolCallId);
		const hostApi = typeof window !== 'undefined' ? (window as any)?.webviewHost : undefined;
		if (!hostApi?.openConversationWindow) {
			return;
		}

		event.preventDefault();

		try {
			const result = await hostApi.openConversationWindow({
				conversationId: chatId,
				href,
				title: 'Subagent',
				windowType: 'subagent'
			});
			if (!result?.success) {
				console.warn(
					'[Collapsible] Failed to open subagent details in detached window:',
					result?.error ?? 'unknown error'
				);
				window.open(href, '_blank', 'noopener,noreferrer');
			}
		} catch (error) {
			console.warn('[Collapsible] Failed to open subagent details in detached window:', error);
			window.open(href, '_blank', 'noopener,noreferrer');
		}
	}

	function formatSubagentTokens(tokens: number | null) {
		if (tokens === null || tokens === undefined || Number.isNaN(tokens)) {
			return '';
		}
		const value = Math.max(0, tokens);
		if (value < 1000) {
			return `~${Math.round(value)} tokens`;
		}
		return `~${(value / 1000).toFixed(1)}k tokens`;
	}

	function extractToolCallCount(message: Record<string, unknown>) {
		let count = 0;
		const contentBlocks = message?.contentBlocks;
		if (Array.isArray(contentBlocks)) {
			for (const block of contentBlocks) {
				if (block?.type !== 'tool_calls') continue;
				const toolCalls = block?.content;
				if (Array.isArray(toolCalls)) {
					count += toolCalls.length;
				} else if (toolCalls) {
					count += 1;
				}
			}
			return count;
		}
		const toolCalls = message?.tool_calls;
		if (Array.isArray(toolCalls)) {
			count += toolCalls.length;
		} else if (toolCalls) {
			count += 1;
		}
		return count;
	}

	function extractTokenCount(message: Record<string, unknown>) {
		return getDisplayTokenCountFromUsage(message?.usage || {});
	}

	function normalizeTextValue(value): string {
		if (!value) return '';
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		return '';
	}

	function extractMessageText(message: Record<string, unknown>) {
		if (!message) return '';
		const content = message?.content;
		if (typeof content === 'string') return content;
		if (Array.isArray(content)) {
			return content
				.map((item) => {
					if (typeof item === 'string') return item;
					if (item && typeof item === 'object') {
						if (item.type && item.type !== 'text') return '';
						return normalizeTextValue(item.text) || normalizeTextValue(item.content) || '';
					}
					return '';
				})
				.join('');
		}

		if (content && typeof content === 'object') {
			const contentText =
				normalizeTextValue(content.text) || normalizeTextValue(content.content) || '';
			if (contentText) return contentText;
		}

		const contentBlocks = message?.contentBlocks;
		if (Array.isArray(contentBlocks)) {
			return contentBlocks
				.map((block) => {
					if (!block || typeof block !== 'object') return '';
					if (block.type && block.type !== 'text') return '';
					if (typeof block.content === 'string') return block.content;
					if (Array.isArray(block.content)) {
						return block.content
							.map((item) =>
								typeof item === 'string'
									? item
									: normalizeTextValue(item?.text) || normalizeTextValue(item?.content) || ''
							)
							.join('');
					}
					return normalizeTextValue(block.content) || normalizeTextValue(block.text) || '';
				})
				.join('');
		}

		return '';
	}

	function estimateTokensFromText(text: string) {
		if (!text) return 0;
		const trimmed = text.trim();
		if (!trimmed) return 0;
		return Math.ceil(trimmed.length / 4);
	}

	function estimateTokensFromMessage(message: Record<string, unknown>) {
		const text = extractMessageText(message);
		return estimateTokensFromText(text);
	}

	function isDoneFlag(value) {
		if (typeof value === 'string') return value.toLowerCase() === 'true';
		return value === true;
	}

	function isUserStopped(value: unknown): boolean {
		return String(value ?? '')
			.trim()
			.toLowerCase() === 'user_stop';
	}

	function isTerminalMessageContext(): boolean {
		return isDoneFlag(messageDone) || !!String(messageStopReason ?? '').trim();
	}

	function hasTerminalMessageError(message: Record<string, unknown> | null | undefined): boolean {
		if (!message) return false;
		const error = (message as Record<string, any>).error;
		if (error === true) return true;
		if (!error || error === false) return false;
		if (typeof error === 'string') return error.trim().length > 0;
		return typeof error === 'object';
	}

	function isTerminalAssistantMessage(
		message: Record<string, unknown> | null | undefined
	): boolean {
		if (!message || message.role !== 'assistant') return false;
		return (
			isDoneFlag(message?.done) ||
			hasTerminalMessageError(message) ||
			!!String(message?.stop_reason ?? '').trim()
		);
	}

	const DEBUG_SUBAGENT_STATS = false;

	function debugSubagentStats(...args: unknown[]) {
		if (!DEBUG_SUBAGENT_STATS) return;
		console.info('[SubagentStats]', ...args);
	}

	let lastSubagentDebugSignature = '';
	let lastSubagentMessageLength: number | null = null;
	let lastSubagentTokenValue: number | null = null;
	let lastUsageTokenValue: number | null = null;
	let lastUsageContentLength: number | null = null;
	let resolvedSubagentChatId: string | null = null;

	function buildAuthHeaders() {
		const token = localStorage?.token;
		return token ? { Authorization: `Bearer ${token}` } : {};
	}

	function applySubagentResultStats(
		stats: ReturnType<typeof extractSubagentResultStats> | null
	) {
		subagentResultStats = stats;
		if (!stats) {
			return;
		}

		if (stats.chatId && stats.chatId !== subagentChatId) {
			subagentChatId = stats.chatId;
		}
		if (typeof stats.toolCallCount === 'number' && stats.toolCallCount >= 0) {
			subagentToolCalls = stats.toolCallCount;
		}
		if (typeof stats.displayTokens === 'number' && stats.displayTokens > 0) {
			subagentTokens = stats.displayTokens;
		}
		if (typeof stats.usageTokens === 'number' && stats.usageTokens > 0) {
			subagentUsageTokens = stats.usageTokens;
		}
	}

	async function fetchSubagentChatId(toolCallId: string) {
		if (!toolCallId || subagentLookupLoading) return;
		subagentLookupLoading = true;
		try {
			const res = await fetch(
				`/api/v1/chats/subagents/tool-call/${encodeURIComponent(toolCallId)}`,
				{
					headers: buildAuthHeaders()
				}
			);
			if (!res.ok) {
				debugSubagentStats('lookup_failed', { toolCallId, status: res.status });
				return;
			}
			const data = await res.json();
			const lookup = resolveSubagentLookupResult({
				previousChatId: subagentChatId,
				lookupPayload: data
			});
			if (lookup.nextChatId && lookup.nextChatId !== subagentChatId) {
				subagentChatId = lookup.nextChatId;
				debugSubagentStats('lookup_success', {
					toolCallId,
					chatId: lookup.nextChatId
				});
			}
			if (lookup.shouldFetchStats && lookup.nextChatId) {
				void fetchSubagentStats(lookup.nextChatId);
			}
		} catch (e) {
			debugSubagentStats('lookup_error', { toolCallId, error: e });
			// Ignore lookup failures
		} finally {
			subagentLookupLoading = false;
		}
	}

	async function fetchSubagentStats(chatId: string) {
		if (!chatId) return;
		// Skip polling when the tab is hidden to reduce unnecessary load
		if (typeof document !== 'undefined' && document.hidden) return;
		if (subagentStatsLoading) {
			debugSubagentStats('stats_skip_inflight', { chatId });
			return;
		}
		subagentStatsLoading = true;
		try {
			const [res, chatState] = await Promise.all([
				fetch(`/api/v1/chats/${chatId}`, {
					headers: buildAuthHeaders()
				}),
				getChatState(chatId)
			]);
			if (!res.ok) {
				debugSubagentStats('stats_failed', { chatId, status: res.status });
				return;
			}
			const data = await res.json();
			const historyMessages = data?.chat?.history?.messages || {};
			let messages = Object.values(historyMessages);
			if (!messages.length && Array.isArray(data?.chat?.messages)) {
				messages = data.chat.messages;
			}
			let toolCallCount = 0;
			let latestTokens: number | null = null;
			let usageTokens: number | null = null;
			const contextTokens =
				typeof chatState?.context_tokens === 'number' ? chatState.context_tokens : null;
			const maxContextTokens =
				typeof chatState?.max_context_tokens === 'number' ? chatState.max_context_tokens : null;
			let isChatDone = false;
			let doneSource = 'unknown';

			for (const message of messages) {
				toolCallCount += extractToolCallCount(message);
			}

			const currentId = data?.chat?.history?.currentId;
			const currentMessage = currentId ? historyMessages[currentId] : null;
			const currentDone = isDoneFlag(currentMessage?.done);
			if (currentMessage?.role === 'assistant') {
				const usageValue = extractTokenCount(currentMessage);
				if (usageValue) {
					usageTokens = usageValue;
					latestTokens = usageValue;
				}
			}

			let lastAssistantMessage: Record<string, unknown> | null = null;
			if (latestTokens === null && messages.length > 0) {
				const orderedMessages = [...messages].sort((a, b) => {
					const aTs = typeof a?.timestamp === 'number' ? a.timestamp : 0;
					const bTs = typeof b?.timestamp === 'number' ? b.timestamp : 0;
					return aTs - bTs;
				});
				for (let i = orderedMessages.length - 1; i >= 0; i -= 1) {
					const message = orderedMessages[i];
					if (message?.role !== 'assistant') continue;
					lastAssistantMessage = message;
					const usageValue = extractTokenCount(message);
					if (usageValue) {
						usageTokens = usageValue;
						latestTokens = usageValue;
						break;
					}
				}
			}

			if (!lastAssistantMessage && messages.length > 0) {
				for (let i = messages.length - 1; i >= 0; i -= 1) {
					const message = messages[i];
					if (message?.role !== 'assistant') continue;
					lastAssistantMessage = message;
					break;
				}
			}

			const currentMessageTerminal = isTerminalAssistantMessage(currentMessage);
			const currentMessageError = hasTerminalMessageError(currentMessage);
			isChatDone = currentMessageTerminal;
			doneSource = currentMessage
				? currentMessageError
					? 'current_message_error'
					: 'current_message'
				: 'none';
			if (!isChatDone && lastAssistantMessage) {
				const lastAssistantTerminal = isTerminalAssistantMessage(lastAssistantMessage);
				if (lastAssistantTerminal) {
					isChatDone = true;
					doneSource = hasTerminalMessageError(lastAssistantMessage)
						? 'last_assistant_error'
						: 'last_assistant';
				}
			}

			let approximateTokens = 0;
			let approximateSource = 'none';
			let approximateMessageId = '';
			if (currentMessage?.role === 'assistant') {
				approximateTokens = estimateTokensFromMessage(currentMessage);
				approximateSource = 'current_message';
				approximateMessageId = currentMessage?.id ?? '';
			}
			if (!approximateTokens && messages.length > 0) {
				for (let i = messages.length - 1; i >= 0; i -= 1) {
					const message = messages[i];
					if (message?.role !== 'assistant') continue;
					approximateTokens = estimateTokensFromMessage(message);
					approximateSource = 'last_assistant';
					approximateMessageId = message?.id ?? '';
					if (approximateTokens) break;
				}
			}

			const currentMessageText =
				currentMessage?.role === 'assistant' ? extractMessageText(currentMessage) : '';
			const currentMessageLength = currentMessageText?.length ?? 0;
			const lastAssistantText = lastAssistantMessage
				? extractMessageText(lastAssistantMessage)
				: '';
			const lastAssistantLength = lastAssistantText?.length ?? 0;
			latestTokens = resolveSubagentDisplayTokenCount({
				contextTokens,
				maxContextTokens,
				usageTokens,
				approximateTokens
			});

			const previousToolCalls = subagentToolCalls;
			const previousTokens = subagentTokens;
			subagentToolCalls = toolCallCount;
			subagentTokens = latestTokens;
			if (usageTokens) {
				subagentUsageTokens = usageTokens;
			}

			const signature = [
				chatId,
				currentId ?? '',
				currentMessage?.id ?? '',
				currentMessage?.role ?? '',
				isChatDone ? 'done' : 'streaming',
				toolCallCount,
				usageTokens ?? '',
				approximateTokens ?? '',
				latestTokens ?? '',
				currentMessageLength,
				lastAssistantLength,
				approximateSource,
				doneSource
			].join('|');
			if (signature !== lastSubagentDebugSignature) {
				lastSubagentDebugSignature = signature;
				debugSubagentStats('stats_update', {
					chatId,
					currentId,
					currentMessageId: currentMessage?.id,
					currentRole: currentMessage?.role,
					currentDone,
					currentMessageError,
					doneSource,
					isChatDone,
					messageCount: messages.length,
					toolCallCount,
					contextTokens,
					maxContextTokens,
					usageTokens,
					approximateTokens,
					approximateSource,
					approximateMessageId,
					latestTokens,
					currentMessageLength,
					lastAssistantMessageId: lastAssistantMessage?.id ?? null,
					lastAssistantDone: lastAssistantMessage?.done ?? null,
					lastAssistantError: hasTerminalMessageError(lastAssistantMessage),
					lastAssistantLength,
					lastUsageTokenValue,
					lastUsageContentLength,
					currentMessageUsage: currentMessage?.usage ?? null
				});
			}

			if (!isChatDone && currentMessageLength > 0) {
				const lengthIncreased =
					lastSubagentMessageLength !== null && currentMessageLength > lastSubagentMessageLength;
				const tokensUnchanged =
					lastSubagentTokenValue !== null && latestTokens === lastSubagentTokenValue;
				if (lengthIncreased && tokensUnchanged) {
					debugSubagentStats('tokens_stalled', {
						chatId,
						currentMessageId: currentMessage?.id,
						currentMessageLength,
						previousMessageLength: lastSubagentMessageLength,
						latestTokens,
						approximateTokens,
						usageTokens,
						approximateSource
					});
				}
			}
			if (currentMessageLength > 0) {
				lastSubagentMessageLength = currentMessageLength;
			}
			if (latestTokens !== null) {
				lastSubagentTokenValue = latestTokens;
			}

			if (toolCallCount > 0 && toolCallCount !== previousToolCalls) {
				triggerStatPulse('toolCalls');
			}
			if (latestTokens !== null && latestTokens !== previousTokens) {
				triggerStatPulse('tokens');
			}

			if (isChatDone) {
				subagentChatTerminal = true;
				debugSubagentStats('poll_complete', {
					chatId,
					toolCallId: subagentToolCallId
				});
				if (subagentPolling) {
					clearInterval(subagentPolling);
					subagentPolling = null;
				}
				if (subagentVisibilityHandler) {
					document.removeEventListener('visibilitychange', subagentVisibilityHandler);
					subagentVisibilityHandler = null;
				}
			} else if (!isChatDone) {
				subagentChatTerminal = false;
			}
		} catch (e) {
			debugSubagentStats('stats_error', { chatId, error: e });
			// Swallow fetch errors to avoid noisy UI
		} finally {
			subagentStatsLoading = false;
		}
	}

	function runSubagentPollingTick() {
		if (!subagentChatId && subagentToolCallId) {
			void fetchSubagentChatId(subagentToolCallId);
			return;
		}
		if (subagentChatId) {
			void fetchSubagentStats(subagentChatId);
		}
	}

	function startSubagentPollingInterval(intervalMs: number) {
		if (subagentPolling) {
			clearInterval(subagentPolling);
			subagentPolling = null;
		}
		subagentPolling = setInterval(() => {
			runSubagentPollingTick();
		}, intervalMs);
	}

	function getSubagentPollIntervalMs(mode: 'foreground' | 'background') {
		return mode === 'background'
			? SUBAGENT_BACKGROUND_POLL_INTERVAL_MS
			: SUBAGENT_POLL_INTERVAL_MS;
	}

	function startSubagentPolling(
		toolCallId: string,
		initialChatId: string | null = null,
		mode: 'foreground' | 'background' = 'foreground'
	) {
		if (!toolCallId) return;
		debugSubagentStats('poll_start', { toolCallId, chatId: initialChatId, mode });
		const pollIntervalMs = getSubagentPollIntervalMs(mode);
		const isSameToolCall = subagentToolCallId === toolCallId;
		subagentToolCallId = toolCallId;
		if (initialChatId) {
			subagentChatId = initialChatId;
		} else if (!isSameToolCall) {
			subagentChatId = null;
		}
		subagentPollingMode = mode;
		if (!isSameToolCall) {
			subagentToolCalls = null;
			subagentTokens = null;
			subagentUsageTokens = null;
			subagentChatTerminal = false;
			toolCallsPulse = false;
			tokensPulse = false;
			subagentFinalizedToolCallId = null;
			lastSubagentMessageLength = null;
			lastSubagentTokenValue = null;
			lastUsageTokenValue = null;
			lastUsageContentLength = null;
		}
		if (initialChatId) {
			void fetchSubagentStats(initialChatId);
		} else {
			void fetchSubagentChatId(toolCallId);
		}
		startSubagentPollingInterval(pollIntervalMs);

		// Pause polling when tab is hidden, resume when visible
		if (typeof document !== 'undefined') {
			if (subagentVisibilityHandler) {
				document.removeEventListener('visibilitychange', subagentVisibilityHandler);
				subagentVisibilityHandler = null;
			}
			subagentVisibilityHandler = () => {
				if (document.hidden && subagentPolling) {
					clearInterval(subagentPolling);
					subagentPolling = null;
					debugSubagentStats('poll_paused_hidden');
				} else if (!document.hidden && !subagentPolling && subagentToolCallId && !subagentChatTerminal) {
					debugSubagentStats('poll_resumed_visible');
					// Immediately fetch once on resume, then restart interval
					runSubagentPollingTick();
					startSubagentPollingInterval(
						getSubagentPollIntervalMs(subagentPollingMode ?? mode)
					);
				}
			};
			document.addEventListener('visibilitychange', subagentVisibilityHandler);
		}
	}

	function stopSubagentPolling() {
		debugSubagentStats('poll_stop', {
			toolCallId: subagentToolCallId,
			chatId: subagentChatId
		});
		if (subagentPolling) {
			clearInterval(subagentPolling);
			subagentPolling = null;
		}
		if (subagentVisibilityHandler) {
			document.removeEventListener('visibilitychange', subagentVisibilityHandler);
			subagentVisibilityHandler = null;
		}
		if (toolCallsPulseTimer) {
			clearTimeout(toolCallsPulseTimer);
			toolCallsPulseTimer = null;
		}
		if (tokensPulseTimer) {
			clearTimeout(tokensPulseTimer);
			tokensPulseTimer = null;
		}
		toolCallsPulse = false;
		tokensPulse = false;
		subagentPollingMode = null;
		subagentUsageTokens = null;
		subagentChatTerminal = false;
		lastSubagentMessageLength = null;
		lastSubagentTokenValue = null;
		lastUsageTokenValue = null;
		lastUsageContentLength = null;
	}

	function triggerStatPulse(kind: 'toolCalls' | 'tokens') {
		if (kind === 'toolCalls') {
			if (toolCallsPulseTimer) {
				clearTimeout(toolCallsPulseTimer);
				toolCallsPulseTimer = null;
			}
			toolCallsPulse = false;
			requestAnimationFrame(() => {
				toolCallsPulse = true;
				toolCallsPulseTimer = setTimeout(() => {
					toolCallsPulse = false;
				}, 500);
			});
			return;
		}

		if (tokensPulseTimer) {
			clearTimeout(tokensPulseTimer);
			tokensPulseTimer = null;
		}
		tokensPulse = false;
		requestAnimationFrame(() => {
			tokensPulse = true;
			tokensPulseTimer = setTimeout(() => {
				tokensPulse = false;
			}, 500);
		});
	}

	$: {
		const nextReasoningTimerKey = getReasoningTimerKey(attributes ?? null);
		if (nextReasoningTimerKey !== reasoningTimerKey) {
			reasoningTimerKey = nextReasoningTimerKey;
			resetReasoningTimerState();
		}
	}

	// Reactive: Re-sync client timer when backend sends elapsed updates
	$: {
		const backendElapsed =
			attributes?.elapsed && attributes.elapsed !== 'None' ? parseInt(attributes.elapsed) : null;

		if (backendElapsed !== null && backendElapsed !== lastBackendElapsed) {
			// Backend sent new elapsed - re-sync by setting client elapsed
			lastBackendElapsed = backendElapsed;
			clientElapsed = backendElapsed;
			lastClientElapsed = backendElapsed;

			// Update timer start point to continue from this value
			timerStartMs = Date.now() - backendElapsed * 1000;
		}
	}

	$: showSubagentToolCalls = typeof subagentToolCalls === 'number' && subagentToolCalls > 0;
	$: showSubagentTokens = typeof subagentTokens === 'number' && subagentTokens > 0;
	$: subagentToolCallsLabel = showSubagentToolCalls ? `${subagentToolCalls} tool calls` : '';
	$: subagentTokensLabel = showSubagentTokens ? formatSubagentTokens(subagentTokens) : '';
	$: resolvedSubagentChatId = subagentChatId ?? subagentResultStats?.chatId ?? null;

		$: {
			const toolName = attributes?.name || '';
			const isSubagentTool = toolName.includes('run_subagent') || toolName.includes('subagent');
			const isStopped = isUserStopped(attributes?.stop_reason);
			const isDone = isDoneFlag(attributes?.done) || isStopped || isTerminalMessageContext();
			const stats = isSubagentTool
				? extractSubagentResultStats(decode(attributes?.result ?? ''))
				: null;
			const nextToolCallId = isSubagentTool ? (attributes?.id ?? null) : null;
			const deferredDetail = nextToolCallId
				? ($subagentDetailsStore[String(nextToolCallId).trim()] ?? null)
				: null;
			const resolvedDetail = resolveSubagentToolCallDetail({
				embeddedStats: stats,
				deferredDetail,
				isTerminal: isDone
			});
			applySubagentResultStats(stats);
			if (isDone && resolvedDetail) {
				if (!stats?.chatId) subagentChatId = resolvedDetail.chatId;
				if (
					(typeof stats?.toolCallCount !== 'number' || stats.toolCallCount <= 0) &&
					resolvedDetail.toolCallCount !== null
				) {
					subagentToolCalls = resolvedDetail.toolCallCount;
				}
				if ((!stats?.displayTokens || stats.displayTokens <= 0) && resolvedDetail.displayTokens) {
					subagentTokens = resolvedDetail.displayTokens;
				}
			}
			const nextChatId = resolvedDetail?.chatId ?? stats?.chatId ?? null;
			const desiredSubagentPollingMode = resolveSubagentPollingMode({
				hasToolCallId: !!nextToolCallId,
				isDone,
				open
			});
			if (nextChatId && nextChatId !== subagentChatId) {
				subagentChatId = nextChatId;
			}
			if (!nextToolCallId && (subagentToolCallId || subagentChatId)) {
				subagentChatId = null;
				subagentToolCallId = null;
				subagentToolCalls = null;
				subagentTokens = null;
				subagentUsageTokens = null;
				subagentResultStats = null;
				subagentFinalizedToolCallId = null;
				stopSubagentPolling();
			} else if (
				nextToolCallId &&
				desiredSubagentPollingMode &&
				(nextToolCallId !== subagentToolCallId ||
					subagentPollingMode !== desiredSubagentPollingMode)
			) {
				startSubagentPolling(nextToolCallId, nextChatId, desiredSubagentPollingMode);
			} else if (isDone && (subagentToolCallId || subagentChatId)) {
				const finalToolCallId = nextToolCallId ?? subagentToolCallId;
				const finalChatId = nextChatId ?? subagentChatId;
				const finalizationKey = finalToolCallId ?? (finalChatId ? `chat:${finalChatId}` : null);
				const alreadyFinalized =
					!!finalizationKey && subagentFinalizedToolCallId === finalizationKey;

				if (!alreadyFinalized) {
					if (finalizationKey) {
						subagentFinalizedToolCallId = finalizationKey;
					}
					if (stats || (isDone && deferredDetail)) {
						stopSubagentPolling();
					} else if (finalChatId) {
						void (async () => {
							await fetchSubagentStats(finalChatId);
							stopSubagentPolling();
						})();
					} else {
						stopSubagentPolling();
					}
				}
			}
		}

	onDestroy(() => {
		stopSubagentPolling();
	});

		// Start/stop timer based on attributes
		$: {
			const isDone =
				attributes?.done === 'true' ||
				attributes?.done === true ||
				isUserStopped(attributes?.stop_reason) ||
				isTerminalMessageContext();
			const startedAt = attributes?.started_at ? parseFloat(attributes.started_at) : null;

		if (!isDone && startedAt && startedAt !== lastStartedAt) {
			// New task started - initialize timer
			lastStartedAt = startedAt;
			lastBackendElapsed = null; // Reset backend sync

			clearReasoningTimerInterval();

			// Initialize timer start point from started_at
			timerStartMs = startedAt * 1000;

			// Start timer that increments from timerStartMs
			timerInterval = setInterval(() => {
				const elapsed = Math.floor((Date.now() - (timerStartMs ?? Date.now())) / 1000);
				clientElapsed = elapsed;
				lastClientElapsed = elapsed;
			}, 100); // Update every 100ms

			// Set initial value
			clientElapsed = Math.floor((Date.now() - (timerStartMs ?? Date.now())) / 1000);
			lastClientElapsed = clientElapsed;
		} else if (isDone) {
			// Task done - clear timer but keep the last elapsed value
			const rawDuration =
				attributes?.duration && attributes.duration !== 'None'
					? parseInt(attributes.duration, 10)
					: null;
			if (Number.isFinite(rawDuration)) {
				clientElapsed = rawDuration as number;
				lastClientElapsed = rawDuration as number;
			} else if (timerStartMs) {
				const elapsed = Math.floor((Date.now() - timerStartMs) / 1000);
				if (elapsed > clientElapsed) {
					clientElapsed = elapsed;
					lastClientElapsed = elapsed;
				}
			}
			clearReasoningTimerInterval();
			lastStartedAt = null;
			lastBackendElapsed = null;
			timerStartMs = null;
		} else if (!startedAt) {
			// Task not started - clear timer and reset elapsed
			resetReasoningTimerState();
		}
	}

	// Always display client elapsed (which gets re-synced from backend updates)
	$: displayElapsed = clientElapsed;

	// For completed states, use duration if available and valid
	$: {
		const rawDuration =
			attributes?.duration && attributes.duration !== 'None'
				? parseInt(attributes.duration, 10)
				: null;
		const hasDuration = Number.isFinite(rawDuration);
		const elapsedFallback = lastClientElapsed || displayElapsed;

		if (hasDuration) {
			displayDuration = rawDuration as number;
		} else {
			displayDuration = elapsedFallback;
		}
	}

	// Historical/leaked reasoning blocks have no duration attribute and never
	// streamed here — suppress the fabricated "0s" instead of displaying it.
	$: showThoughtTime = shouldShowThoughtDuration(attributes, lastClientElapsed);

	// Cleanup timer on component destroy
	onDestroy(() => {
		clearReasoningTimerInterval();
	});

	function parseJSONString(str) {
		try {
			return parseJSONString(JSON.parse(str));
		} catch (e) {
			return str;
		}
	}

	function formatJSONString(str) {
		try {
			const parsed = parseJSONString(str);
			// If parsed is an object/array, then it's valid JSON
			if (typeof parsed === 'object') {
				return JSON.stringify(parsed, null, 2);
			} else {
				// It's a primitive value like a number, boolean, etc.
				return `${JSON.stringify(String(parsed))}`;
			}
		} catch (e) {
			// Not valid JSON, return as-is
			return str;
		}
	}

	function buildToolCopyText(toolName: string | null, args: string, result: string): string {
		const inputIsEmpty = args === '{}' || args === '' || !args;
		const outputIsEmpty = result === '{}' || result === '' || !result;
		const isPython = !inputIsEmpty && isPythonExecuteTool(toolName);
		const isBash = !inputIsEmpty && isBashExecuteTool(toolName);
		const pythonExtract = isPython ? extractPythonScript(args) : null;
		const bashExtract = isBash ? extractBashCommand(args) : null;

		let inputText = inputIsEmpty ? 'None' : formatJSONString(args);
		if (pythonExtract?.script) {
			inputText = pythonExtract.modifiedArgs;
		} else if (bashExtract?.command) {
			inputText = bashExtract.modifiedArgs;
		}

		const outputText = outputIsEmpty ? 'None' : formatJSONString(result);

		const sections = [`Tool ID: ${toolName ?? ''}`, '', 'Input:', inputText];
		if (pythonExtract?.script) {
			sections.push('', 'Script:', pythonExtract.script);
		}
		if (bashExtract?.command) {
			sections.push('', 'Command:', bashExtract.command);
		}
		sections.push('', 'Output:', outputText);

		return sections.join('\n');
	}

	async function copyToolDetails(toolName: string | null, args: string, result: string) {
		const text = buildToolCopyText(toolName, args, result);
		const res = await copyToClipboard(text);

		if (res) {
			toast.success($i18n.t('Copying to clipboard was successful!'));
		} else {
			toast.error($i18n.t('Failed to copy'));
		}
	}

	async function copyThoughtDetails(text: string | null) {
		const res = await copyToClipboard(text ?? '');

		if (res) {
			toast.success($i18n.t('Copying to clipboard was successful!'));
		} else {
			toast.error($i18n.t('Failed to copy'));
		}
	}

	// Legacy function for backwards compatibility (used in non-tool_calls contexts)
	function formatToolName(name: string): string {
		return formatToolDisplayName(name, null);
	}

	// ============================================================================
	// [CodeHighlighting] - Code extraction and syntax highlighting for VM tools
	// ============================================================================

	// Check if tool is a Python execution tool
	function isPythonExecuteTool(toolName: string | null): boolean {
		if (!toolName) return false;
		const normalizedName = toolName
			.toLowerCase()
			.replace(/^tool_/, '')
			.replace(/_(post|get|put|delete|patch)$/i, '');
		const suffixes = ['python', 'execute_python'];
		return suffixes.some(
			(suffix) =>
				normalizedName === suffix ||
				normalizedName.endsWith(`_${suffix}`) ||
				normalizedName.endsWith(`-${suffix.replace(/_/g, '-')}`)
		);
	}

	// Check if tool is a Bash execution tool
	function isBashExecuteTool(toolName: string | null): boolean {
		if (!toolName) return false;
		const normalizedName = toolName
			.toLowerCase()
			.replace(/^tool_/, '')
			.replace(/_(post|get|put|delete|patch)$/i, '');
		const suffixes = ['bash', 'execute_bash'];
		return suffixes.some(
			(suffix) =>
				normalizedName === suffix ||
				normalizedName.endsWith(`_${suffix}`) ||
				normalizedName.endsWith(`-${suffix.replace(/_/g, '-')}`)
		);
	}

	// Extract Python script from args and return modified args with placeholder
	function extractPythonScript(args: string): {
		modifiedArgs: string;
		script: string | null;
	} {
		try {
			const parsed = JSON.parse(args);

			if (parsed && typeof parsed.script === 'string') {
				const script = parsed.script;
				// Create modified args with placeholder
				const modified = { ...parsed, script: '(see below)' };
				return {
					modifiedArgs: JSON.stringify(modified, null, 2),
					script
				};
			}
		} catch {
			// Ignore invalid JSON and return the original args.
		}
		return { modifiedArgs: args, script: null };
	}

	// Extract bash command from args and return modified args with placeholder
	function extractBashCommand(args: string): {
		modifiedArgs: string;
		command: string | null;
	} {
		try {
			const parsed = JSON.parse(args);

			if (parsed && typeof parsed.command === 'string') {
				const command = parsed.command;
				// Create modified args with placeholder
				const modified = { ...parsed, command: '(see below)' };
				return {
					modifiedArgs: JSON.stringify(modified, null, 2),
					command
				};
			}
		} catch {
			// Ignore invalid JSON and return the original args.
		}
		return { modifiedArgs: args, command: null };
	}

	// Server IDs for tool name prefix matching
	let serverIds: string[] = [];
	let lastUnknownToolServerIdRefresh: string | null = null;

	$: serverIds = $mcpServerIds;

	// Reactive: compute server ID and icon URL when attributes change
	$: toolServerId = attributes?.name
		? extractServerIdFromToolName(attributes.name, serverIds)
		: null;
	$: serverIconUrl = toolServerId
		? `http://localhost:9876/api/mcp/servers/${toolServerId}/icon`
		: null;
	$: if (attributes?.name) {
		if (toolServerId || !looksLikeMcpToolName(attributes.name)) {
			lastUnknownToolServerIdRefresh = null;
		} else if (lastUnknownToolServerIdRefresh !== attributes.name) {
			lastUnknownToolServerIdRefresh = attributes.name;
			void ensureMcpServerIdForToolName(attributes.name);
		}
	} else {
		lastUnknownToolServerIdRefresh = null;
	}

	// Track icon load errors to hide broken images
	let iconLoadError = false;
	$: if (toolServerId) iconLoadError = false; // Reset on server ID change
</script>

	<div
		{id}
		class="{className} {isWorkActivityType(attributes?.type) ? 'portico-work-activity-detail' : ''}"
		{dir}
	>
		{#if attributes?.type === 'tool_preparation'}
			{@const isPreparationStopped = isUserStopped(attributes?.stop_reason)}
			{@const isPreparationDone = isDoneFlag(attributes?.done) || isPreparationStopped}
			<!-- Generating tool call inputs... -->
			<div class="py-0.5 w-full cursor-pointer" on:click={() => {}}>
				<div class="w-full font-medium flex items-center gap-2 {!isPreparationDone ? 'shimmer' : ''}">
					{#if isPreparationDone}
						<!-- Completed: checkmark + "All tool calls generated. (Xs)" -->
						<div class="text-gray-500 dark:text-gray-400">✓</div>
						<div class="text-gray-500 dark:text-gray-400">
							<Markdown
								id={`${collapsibleId}-tool-preparation-complete`}
								content={isPreparationStopped
									? `Stopped generating tool call inputs (${displayDuration}s)`
									: `All tool calls generated (${displayDuration}s)`}
							/>
						</div>
					{:else}
					<!-- In progress: spinner + "Generating tool call inputs... (Xs)" -->
					<div>
						<Spinner className="size-4" />
					</div>
					<Markdown
						id={`${collapsibleId}-tool-preparation-progress`}
						content={`Generating tool call inputs... (${displayElapsed}s)`}
					/>
				{/if}
			</div>
			</div>
		{:else if attributes?.type === 'tool_analysis'}
			{@const isAnalysisStopped = isUserStopped(attributes?.stop_reason)}
			{@const isAnalysisDone = isDoneFlag(attributes?.done) || isAnalysisStopped}
			<!-- Analyzing tool results... -->
			<div class="py-0.5 w-full cursor-pointer" on:click={() => {}}>
				<div class="w-full font-medium flex items-center gap-2 {!isAnalysisDone ? 'shimmer' : ''}">
					{#if isAnalysisDone}
						<!-- Completed: checkmark + "Tool results analyzed (Xs)" -->
						<div class="text-gray-500 dark:text-gray-400">✓</div>
						<div class="text-gray-500 dark:text-gray-400">
							<Markdown
								id={`${collapsibleId}-tool-analysis-complete`}
								content={isAnalysisStopped
									? `Stopped analyzing tool results (${displayDuration}s)`
									: `Tool results analyzed (${displayDuration}s)`}
							/>
						</div>
					{:else}
					<!-- In progress: spinner + "Analyzing tool results... (Xs)" -->
					<div>
						<Spinner className="size-4" />
					</div>
					<Markdown
						id={`${collapsibleId}-tool-analysis-progress`}
						content={`Analyzing tool results... (${displayElapsed}s)`}
					/>
				{/if}
			</div>
		</div>
	{:else if attributes?.type === 'tool_calls'}
		{@const args = decode(attributes?.arguments)}
		{@const result = decode(attributes?.result ?? '')}
			{@const embeds = parseJSONString(decode(attributes?.embeds ?? ''))}
			{@const formattedArgs = formatJSONString(args)}
			{@const formattedResult = formatJSONString(result)}
			{@const isParentMessageTerminal = isTerminalMessageContext()}
			{@const hasExplicitToolDone = isDoneFlag(attributes?.done)}
			{@const hasExplicitToolResult = Object.prototype.hasOwnProperty.call(attributes ?? {}, 'result')}
			{@const isToolStopped = isUserStopped(attributes?.stop_reason)}
			{@const isToolDisplayStopped = !hasExplicitToolResult && (isToolStopped || (!hasExplicitToolDone && !!String(messageStopReason ?? '').trim()))}
			{@const isToolDone = hasExplicitToolDone || isToolStopped || isParentMessageTerminal}
			{@const toolPhase = String(attributes?.phase ?? '').trim().toLowerCase()}
			{@const isToolPreparing = !isToolDone && toolPhase === 'preparing'}
			{@const toolBlockAnimationClass = isToolDone ? '' : isToolPreparing ? 'tool-preview-shimmer' : 'tool-shimmer'}
			{@const toolRunningLabel = isToolPreparing ? 'Preparing tool' : 'Running tool'}
			{@const toolDoneLabel = isToolDisplayStopped ? (toolPhase === 'preparing' ? 'Stopped preparing tool' : 'Stopped tool') : 'Ran tool'}
			{@const toolBlockBg = $isDarkMode ? 'rgba(79, 148, 255, 0.16)' : '#cfe3fb'}
			{@const toolBlockShadow = $isDarkMode ? 'none' : 'inset 0 0 0 1px rgba(37, 99, 235, 0.28), 0 1px 2px rgba(15, 23, 42, 0.05)'}
			{@const toolIconBg = $isDarkMode ? 'rgba(79, 148, 255, 0.2)' : '#3f75b8'}
			{@const toolIconShadow = $isDarkMode ? 'none' : 'inset 0 0 0 1px rgba(15, 64, 118, 0.28), 0 1px 2px rgba(15, 23, 42, 0.14)'}
			{@const toolIconText = $isDarkMode ? '#d3e3ff' : '#245b9e'}
			{@const toolChipBg = $isDarkMode ? 'rgba(79, 148, 255, 0.22)' : 'rgba(255, 255, 255, 0.58)'}
			{@const toolChipText = $isDarkMode ? '#d3e3ff' : '#174a82'}
			{@const toolMetaTextClass = $isDarkMode ? 'text-slate-300' : 'text-slate-800'}
			{@const toolDurationTextClass = $isDarkMode ? 'text-slate-400' : 'text-slate-600'}
			{@const toolDetailLinkColor = $isDarkMode ? '#60a5fa' : '#1d4ed8'}
			{@const toolDetailLinkClass = 'transition-opacity hover:opacity-80'}
			{@const toolControlClass = $isDarkMode ? 'p-1 hover:bg-white/5 rounded-lg dark:hover:text-white transition' : 'p-1 hover:bg-blue-600/10 rounded-lg hover:text-blue-900 transition'}
			{@const toolSectionHeadingClass = $isDarkMode ? 'text-xs font-medium text-white' : 'text-xs font-medium text-slate-800'}
			{@const toolSectionTextClass = $isDarkMode ? 'text-xs text-gray-400 font-mono' : 'text-xs text-slate-700 font-mono'}
			{@const toolEmptyTextClass = $isDarkMode ? 'text-xs text-gray-500' : 'text-xs text-slate-500'}
			{@const toolSkeletonBg = $isDarkMode ? 'rgba(31, 41, 55, 0.5)' : 'rgba(37, 99, 235, 0.1)'}

		{#if embeds && Array.isArray(embeds) && embeds.length > 0}
			<div class="py-1 w-full cursor-pointer">
				<div class=" w-full text-xs text-gray-500">
					<div class="">
						{attributes.name}
					</div>
				</div>

				{#each embeds as embed, idx}
					<div class="my-2" id={`${collapsibleId}-tool-calls-${attributes?.id}-embed-${idx}`}>
						<FullHeightIframe
							src={embed}
							{args}
							allowScripts={true}
							allowForms={true}
							allowSameOrigin={true}
							allowPopups={true}
						/>
					</div>
				{/each}
			</div>
		{:else}
			<!-- Tool calls with distinct styling -->
			<!-- svelte-ignore a11y-no-static-element-interactions -->
			<!-- svelte-ignore a11y-click-events-have-key-events -->
			<div
				class="message-tool-block rounded-lg px-4 py-[0.3125rem] cursor-pointer {toolBlockAnimationClass}"
				style="background-color: {toolBlockBg}; color: {toolChipText}; box-shadow: {toolBlockShadow};"
				on:click={toggleOpen}
				on:keydown={handleKeydown}
				role="button"
				tabindex="0"
			>
					<div class="collapsible-header-row w-full flex items-center justify-between gap-2">
						{#if isToolDone}
						<!-- Tool icon for completed - use MCP server logo if available, fallback to generic tool icon -->
						{#if serverIconUrl && !iconLoadError}
							<img
								src={serverIconUrl}
								alt=""
								class="flex-shrink-0 self-center rounded-lg"
								style="width: 26px; height: 26px; object-fit: contain; background: {toolIconBg}; padding: 2px; box-shadow: {toolIconShadow};"
								on:error={() => (iconLoadError = true)}
							/>
						{:else}
							<div
								class="flex-shrink-0 self-center grid size-[26px] place-items-center rounded-lg"
								style="background: {toolIconBg}; color: {toolIconText}; box-shadow: {toolIconShadow};"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									class="size-4"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path
										d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
									/>
								</svg>
							</div>
						{/if}
					{:else}
						<!-- Running state - use MCP server logo if available, fallback to spinner -->
						{#if serverIconUrl && !iconLoadError}
							<img
								src={serverIconUrl}
								alt=""
								class="flex-shrink-0 self-center rounded-lg"
								style="width: 26px; height: 26px; object-fit: contain; background: {toolIconBg}; padding: 2px; box-shadow: {toolIconShadow};"
								on:error={() => (iconLoadError = true)}
							/>
						{:else}
							<div
								class="flex-shrink-0 self-center grid size-[26px] place-items-center rounded-lg"
								style="background: {toolIconBg}; color: {toolIconText}; box-shadow: {toolIconShadow};"
							>
								<Spinner className="size-4" />
							</div>
						{/if}
					{/if}

						<div class="flex-1 min-w-0 font-semibold dark:text-gray-200">
							{#if isToolDone}
								<div class="{toolMetaTextClass} flex items-center gap-1.5 min-w-0 text-sm font-light italic">
									<span class="whitespace-nowrap">{toolDoneLabel}</span>
								<span
									class="tool-name-chip font-medium px-2 py-0.5 rounded min-w-0 truncate"
									style="font-style: normal; background-color: {toolChipBg}; color: {toolChipText}; -webkit-text-fill-color: {toolChipText};"
									>{formatToolDisplayName(attributes.name, toolServerId)}</span
								>
								{#if resolvedSubagentChatId}
									<a
										href={buildSubagentDetailsHref(
											resolvedSubagentChatId,
											subagentToolCallId ?? attributes?.id
										)}
										target="_blank"
										rel="noopener noreferrer"
										class="relative z-10 pointer-events-auto text-sm underline whitespace-nowrap mr-0.5 {toolDetailLinkClass}"
										style="font-style: normal; color: {toolDetailLinkColor}; -webkit-text-fill-color: {toolDetailLinkColor};"
										on:click={(e) =>
											handleSubagentDetailsClick(
												e,
												resolvedSubagentChatId,
												subagentToolCallId ?? attributes?.id
											)
										}
									>
										View details ↗
									</a>
								{/if}
								<span class="{toolDurationTextClass} whitespace-nowrap">{displayDuration}s</span>
							</div>
						{:else}
							<div class="{toolMetaTextClass} flex items-center gap-1.5 min-w-0 text-sm font-light italic">
								<span class="whitespace-nowrap">{toolRunningLabel}</span>
								<span
									class="tool-name-chip font-medium px-2 py-0.5 rounded min-w-0 truncate"
									style="font-style: normal; background-color: {toolChipBg}; color: {toolChipText}; -webkit-text-fill-color: {toolChipText};"
									>{formatToolDisplayName(attributes.name, toolServerId)}</span
								>
								{#if resolvedSubagentChatId}
									<a
										href={buildSubagentDetailsHref(
											resolvedSubagentChatId,
											subagentToolCallId ?? attributes?.id
										)}
										target="_blank"
										rel="noopener noreferrer"
										class="relative z-10 pointer-events-auto text-sm underline whitespace-nowrap mr-0.5 {toolDetailLinkClass}"
										style="font-style: normal; color: {toolDetailLinkColor}; -webkit-text-fill-color: {toolDetailLinkColor};"
										on:click={(e) =>
											handleSubagentDetailsClick(
												e,
												resolvedSubagentChatId,
												subagentToolCallId ?? attributes?.id
											)
										}
									>
										View details ↗
									</a>
								{/if}
								<span class="{toolDurationTextClass} whitespace-nowrap">... {displayElapsed}s</span>
							</div>
						{/if}
					</div>

					<div class="flex items-center gap-1.5 flex-shrink-0">
						{#if resolvedSubagentChatId || subagentToolCallsLabel || subagentTokensLabel}
							<div class="inline-flex items-center gap-3 text-[13px]">
								{#if subagentToolCallsLabel}
									<div
										class="relative z-10 inline-flex items-center gap-2.5 ml-4"
										class:subagent-stat-pulse={toolCallsPulse}
									>
										<svg
											class="w-[14px] h-[14px] -translate-x-[1px] translate-y-[1px]"
											style="color: {toolChipText};"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="1.8"
											stroke-linecap="round"
											stroke-linejoin="round"
											aria-hidden="true"
										>
											<path
												d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
											/>
										</svg>
										<span
											class="tool-name-chip px-2 py-0.5 rounded text-[13px]"
											class:font-medium={!toolCallsPulse}
											class:font-semibold={toolCallsPulse}
											style="font-style: normal; background-color: {toolChipBg}; color: {toolChipText}; -webkit-text-fill-color: {toolChipText};"
										>
											{subagentToolCallsLabel}
										</span>
									</div>
								{/if}
								{#if subagentTokensLabel}
									<div class="relative z-10 inline-flex items-center gap-0.5">
										<svg
											class="w-[21px] h-[21px] translate-y-[1px] mr-1"
											style="color: {toolChipText};"
											viewBox="0 0 20 20"
											fill="none"
											stroke="currentColor"
											stroke-width="1.8"
											stroke-linecap="round"
											stroke-linejoin="round"
											aria-hidden="true"
										>
											<path d="M10 4v9m0 0l-3.5-3.5M10 13l3.5-3.5" />
										</svg>
										<span
											class="tool-name-chip px-2 py-0.5 rounded text-[13px] font-medium"
											style="font-style: normal; background-color: {toolChipBg}; color: {toolChipText}; -webkit-text-fill-color: {toolChipText};"
										>
											{subagentTokensLabel}
										</span>
									</div>
								{/if}
							</div>
						{/if}
						<Tooltip content={$i18n.t('Copy')} placement="bottom">
							<button
								type="button"
								aria-label={$i18n.t('Copy tool details')}
								class={toolControlClass}
								on:click|stopPropagation={() => {
									copyToolDetails(attributes?.name, args, result);
								}}
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									fill="none"
									aria-hidden="true"
									viewBox="0 0 24 24"
									stroke-width="2.3"
									stroke="currentColor"
									class="w-4 h-4"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"
									/>
								</svg>
							</button>
						</Tooltip>
						<div class="flex self-center translate-y-[1px]">
							{#if open}
								<ChevronUp strokeWidth="3.5" className="size-3.5" />
							{:else}
								<ChevronDown strokeWidth="3.5" className="size-3.5" />
							{/if}
						</div>
					</div>
				</div>

				{#if !grow}
					{#if open && !hide}
						<div
							class="message-tool-block-content mt-2 pt-1.5"
							style="animation: fadeIn 150ms ease-out; color: {toolChipText};"
							on:click={(e) => e.stopPropagation()}
						>
							{#if attributes?.type === 'tool_calls'}
								<!-- Tool ID section -->
								<div class="mb-3">
									<div class="{toolSectionHeadingClass} mb-1.5">Tool ID</div>
									<div class={toolSectionTextClass}>
										{attributes.name}
									</div>
								</div>

								<!-- Input section -->
								<div class="mb-6">
									<div class="{toolSectionHeadingClass} mb-3">Input</div>
									{#if args === '{}' || args === '' || !args}
										<div class={toolEmptyTextClass}>None</div>
									{:else if shouldRenderContent}
										{@const isPython = isPythonExecuteTool(attributes.name)}
										{@const isBash = isBashExecuteTool(attributes.name)}
										{@const pythonExtract = isPython ? extractPythonScript(args) : null}
										{@const bashExtract = isBash ? extractBashCommand(args) : null}
										{@const displayArgs = pythonExtract?.script
											? pythonExtract.modifiedArgs
											: bashExtract?.command
												? bashExtract.modifiedArgs
												: formattedArgs}

										<CodeBlock
											id={`${collapsibleId}-tool-calls-${attributes?.id}-input`}
											lang="json"
											code={displayArgs}
										/>

										{#if pythonExtract?.script}
											<div class="mt-3">
												<CodeBlock
													id={`${collapsibleId}-tool-calls-${attributes?.id}-input-script`}
													lang="python"
													code={pythonExtract.script}
												/>
											</div>
										{/if}

										{#if bashExtract?.command}
											<div class="mt-3">
												<CodeBlock
													id={`${collapsibleId}-tool-calls-${attributes?.id}-input-command`}
													lang="bash"
													code={bashExtract.command}
												/>
											</div>
										{/if}
									{:else}
										<div class="h-20 rounded animate-pulse" style="background-color: {toolSkeletonBg};"></div>
									{/if}
								</div>

									<!-- Output section (only if done) -->
									{#if isToolDone}
									<div class="mb-6">
										<div class="{toolSectionHeadingClass} mb-3">Output</div>
										{#if result === '{}' || result === '' || !result}
											<div class={toolEmptyTextClass}>None</div>
										{:else if shouldRenderContent}
											<CodeBlock
												id={`${collapsibleId}-tool-calls-${attributes?.id}-output`}
												lang="json"
												code={formattedResult}
											/>
										{:else}
											<div class="h-20 rounded animate-pulse" style="background-color: {toolSkeletonBg};"></div>
										{/if}
									</div>
								{/if}
							{:else}
								<slot name="content" />
							{/if}
						</div>
					{/if}
				{/if}
			</div>
		{/if}

		{:else if attributes?.type === 'reasoning'}
			<!-- Reasoning blocks with distinct styling -->
			<!-- svelte-ignore a11y-no-static-element-interactions -->
			<!-- svelte-ignore a11y-click-events-have-key-events -->
				{@const isThoughtStopped = isUserStopped(attributes?.stop_reason)}
				{@const isThoughtDone = isDoneFlag(attributes?.done) || isThoughtStopped}
				{@const thoughtBlockBg = $isDarkMode ? '#3f454d' : '#e3ebf3'}
				{@const thoughtBlockShadow = $isDarkMode ? 'none' : 'inset 0 0 0 1px rgba(51, 65, 85, 0.08)'}
				{@const thoughtIconBg = $isDarkMode ? '#59626d' : '#c9d7e6'}
				{@const thoughtIconText = $isDarkMode ? '#f8fbff' : '#405a78'}
				<div
					class="message-thought-block rounded-lg px-4 py-[0.3125rem] cursor-pointer {isThoughtDone ? '' : 'message-thought-block--running'}"
					style="background-color: {thoughtBlockBg}; box-shadow: {thoughtBlockShadow};"
					on:click={toggleOpen}
					on:keydown={handleKeydown}
					role="button"
					tabindex="0"
				>
					<div class="collapsible-header-row w-full font-medium flex items-center justify-between gap-2">
						{#if !isThoughtDone}
							<div
								class="flex-shrink-0 p-[2.5px] rounded-lg"
								style="background: {thoughtIconBg}; color: {thoughtIconText};"
							>
								<Spinner className="size-4" />
							</div>
						{:else}
							<!-- Brain/thought icon -->
							<div
								class="flex-shrink-0 p-[2.5px] rounded-lg"
								style="background: {thoughtIconBg}; color: {thoughtIconText};"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									class="size-4"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path
										d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"
									/>
									<path
										d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"
									/>
								</svg>
							</div>
						{/if}

						<div
							class="thought-status-text flex-1 min-w-0 flex items-center gap-1.5 text-sm font-light italic {isThoughtDone ? '' : 'thought-status-text--running'}"
						>
							<span class="thought-status-label">
								{#if isThoughtStopped}
									Stopped
								{:else if isThoughtDone}
									{$i18n.t('Thought')}
								{:else}
									{$i18n.t('Thinking...')}
								{/if}
							</span>
							{#if !isThoughtDone || showThoughtTime}
								<span class="thought-status-time">
									{#if isThoughtDone}
										{displayDuration}s
									{:else}
										{displayElapsed}s
									{/if}
								</span>
							{/if}
						</div>

				<div class="flex items-center gap-1.5 flex-shrink-0">
					<Tooltip content={$i18n.t('Copy')} placement="bottom">
						<button
							type="button"
							aria-label={$i18n.t('Copy thought')}
							class="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg dark:hover:text-white hover:text-black transition"
							on:click|stopPropagation={() => {
								copyThoughtDetails(copyText);
							}}
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								fill="none"
								aria-hidden="true"
								viewBox="0 0 24 24"
								stroke-width="2.3"
								stroke="currentColor"
								class="w-4 h-4"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"
								/>
							</svg>
						</button>
					</Tooltip>
					<div class="flex self-center translate-y-[1px]">
						{#if open}
							<ChevronUp strokeWidth="3.5" className="size-3.5" />
						{:else}
							<ChevronDown strokeWidth="3.5" className="size-3.5" />
						{/if}
					</div>
				</div>
			</div>

			{#if open && !hide}
				<div
					class="message-thought-block-content mt-2 pt-1.5 text-sm"
					style="animation: fadeIn 150ms ease-out;"
					on:click={(e) => e.stopPropagation()}
				>
					<slot name="content" />
				</div>
			{/if}
		</div>
		{:else}
			{#if title !== null}
				{@const isGenericStopped = isUserStopped(attributes?.stop_reason)}
				{@const isGenericDone = isDoneFlag(attributes?.done) || isGenericStopped}
				<!-- svelte-ignore a11y-no-static-element-interactions -->
				<!-- svelte-ignore a11y-click-events-have-key-events -->
				<div
				class="{buttonClassName} cursor-pointer"
				on:click={toggleOpen}
				on:keydown={handleKeydown}
				role="button"
					tabindex="0"
				>
					<div
						class=" w-full font-medium flex items-center justify-between gap-2 {!isGenericDone
						? 'shimmer'
						: ''}"
					>
						{#if !isGenericDone}
							<div>
								<Spinner className="size-4" />
							</div>
					{/if}

						<div class="text-gray-500 dark:text-gray-400">
							{#if attributes?.type === 'code_interpreter'}
								{#if isGenericStopped}
									Stopped
								{:else if isGenericDone}
									{$i18n.t('Analyzed')}
								{:else}
									{$i18n.t('Analyzing...')}
							{/if}
						{:else}
							{title}
						{/if}
					</div>

					<div class="flex self-center translate-y-[1px]">
						{#if open}
							<ChevronUp strokeWidth="3.5" className="size-3.5" />
						{:else}
							<ChevronDown strokeWidth="3.5" className="size-3.5" />
						{/if}
					</div>
				</div>
			</div>
		{:else}
			<!-- svelte-ignore a11y-no-static-element-interactions -->
			<!-- svelte-ignore a11y-click-events-have-key-events -->
			<div
				class="{buttonClassName} cursor-pointer"
				on:click={toggleOpen}
				on:keydown={handleKeydown}
				role="button"
				tabindex="0"
			>
				<div>
					<div class="flex items-start justify-between">
						<slot />

						{#if chevron}
							<div class="flex self-start translate-y-1">
								{#if open}
									<ChevronUp strokeWidth="3.5" className="size-3.5" />
								{:else}
									<ChevronDown strokeWidth="3.5" className="size-3.5" />
								{/if}
							</div>
						{/if}
					</div>

					{#if grow}
						{#if open && !hide}
							<div
								transition:slide={{
									duration: 300,
									easing: quintOut,
									axis: 'y'
								}}
								on:click={(e) => {
									e.stopPropagation();
								}}
							>
								<slot name="content" />
							</div>
						{/if}
					{/if}
				</div>
			</div>
		{/if}

		{#if !grow}
			{#if open && !hide}
				<div transition:slide={{ duration: 300, easing: quintOut, axis: 'y' }}>
					<slot name="content" />
				</div>
			{/if}
		{/if}
	{/if}
</div>

<style>
	@keyframes fadeIn {
		from {
			opacity: 0;
			transform: translateY(-8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes toolShimmer {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(100%);
		}
	}

	@keyframes toolPreviewPulse {
		0%,
		100% {
			opacity: 0.18;
		}
		50% {
			opacity: 0.42;
		}
	}

	.tool-shimmer {
		position: relative;
		overflow: hidden;
	}

	.tool-preview-shimmer {
		position: relative;
		overflow: hidden;
	}

	.tool-shimmer::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: linear-gradient(
			90deg,
			transparent 0%,
			rgba(255, 255, 255, 0.45) 50%,
			transparent 100%
		);
		z-index: 0;
		transform: translateX(-100%);
		animation: toolShimmer 2.4s linear infinite;
		pointer-events: none;
	}

	.tool-preview-shimmer::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: rgba(255, 255, 255, 0.32);
		z-index: 0;
		animation: toolPreviewPulse 1.6s ease-in-out infinite;
		pointer-events: none;
	}

	@keyframes subagentStatPulse {
		0% {
			transform: scale(1);
		}
		40% {
			transform: scale(1.2);
		}
		100% {
			transform: scale(1);
		}
	}

		.subagent-stat-pulse {
			animation: subagentStatPulse 0.5s ease;
			transform-origin: center;
		}

		.message-thought-block {
			position: relative;
		}

		.thought-status-text {
			color: #334155;
		}

		.thought-status-time {
			color: #64748b;
		}

		:global(.dark) .thought-status-text {
			color: #f8fbff;
		}

		:global(.dark) .thought-status-time {
			color: #d3e3ff;
		}

		.message-thought-block--running {
			overflow: hidden;
		}

		.message-thought-block--running > * {
			position: relative;
			z-index: 1;
		}

		.message-thought-block--running::after {
			content: '';
			position: absolute;
			inset: -1px;
			border-radius: inherit;
			background: linear-gradient(
				100deg,
				transparent 0%,
				rgba(36, 95, 212, 0.08) 34%,
				rgba(255, 255, 255, 0.28) 50%,
				rgba(36, 95, 212, 0.08) 66%,
				transparent 100%
			);
			transform: translateX(-115%);
			animation: thoughtBlockSpotlight 2.8s ease-in-out infinite;
			pointer-events: none;
			z-index: 0;
		}

		.thought-status-text--running .thought-status-label,
		.thought-status-text--running .thought-status-time {
			--thought-text-rest: #334155;
			--thought-text-mid: #64748b;
			--thought-text-peak: #245fd4;

			animation: thoughtTextSpotlight 2.8s ease-in-out infinite;
		}

		.thought-status-text--running .thought-status-time {
			animation-delay: 0.08s;
		}

		:global(.dark) .message-thought-block--running::after {
			background: linear-gradient(
				100deg,
				transparent 0%,
				rgba(79, 148, 255, 0.08) 34%,
				rgba(248, 251, 255, 0.18) 50%,
				rgba(79, 148, 255, 0.08) 66%,
				transparent 100%
			);
		}

		:global(.dark) .thought-status-text--running .thought-status-label,
		:global(.dark) .thought-status-text--running .thought-status-time {
			--thought-text-rest: #f8fbff;
			--thought-text-mid: #d3e3ff;
			--thought-text-peak: var(--portico-accent-text, #4f94ff);
		}

		@keyframes thoughtBlockSpotlight {
			0% {
				transform: translateX(-115%);
				opacity: 0;
			}
			18% {
				opacity: 1;
			}
			62% {
				transform: translateX(115%);
				opacity: 1;
			}
			100% {
				transform: translateX(115%);
				opacity: 0;
			}
		}

		@keyframes thoughtTextSpotlight {
			0% {
				color: var(--thought-text-rest);
				text-shadow: none;
			}
			35% {
				color: var(--thought-text-mid);
				text-shadow: none;
			}
			50% {
				color: var(--thought-text-peak);
				text-shadow: 0 0 14px rgba(79, 148, 255, 0.36);
			}
			65% {
				color: var(--thought-text-mid);
				text-shadow: none;
			}
			100% {
				color: var(--thought-text-rest);
				text-shadow: none;
			}
		}

		:global(.dark) .tool-shimmer::after {
			background: linear-gradient(
				90deg,
			transparent 0%,
			rgba(255, 255, 255, 0.2) 50%,
			transparent 100%
		);
	}

	:global(.dark) .tool-preview-shimmer::after {
		background: rgba(255, 255, 255, 0.14);
	}

	.collapsible-header-row {
		min-height: 32px;
		/* Counter the global `html { word-break: break-word }`: it reduces
		   flex-item min-content width to ~1ch, letting narrow layouts squeeze
		   the status text into a one-character-per-line column. The tool-name
		   chip is the designated shrinker (truncate) instead. */
		word-break: normal;
		overflow-wrap: normal;
	}

	/* Add spacing around code blocks in thought content */
	:global(.text-sm .rounded-3xl.border.flex.flex-col) {
		margin-top: 0.75rem !important;
		margin-bottom: 0.75rem !important;
	}
</style>
