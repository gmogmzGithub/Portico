<!--
  PORTICO PATCHED FILE

  Changes from original Open WebUI SearchModal.svelte:
  1. Removed the "Create a new note" quick action
  2. PORTICO PATCH: Message-level search with chat search backend
     - Message-level grouped results with highlighted snippets
     - Search scope filter bar (All, Today, Last 7 days, Last 30 days, My Messages, AI Responses)
     - Case-sensitive and regex toggles
     - Recent searches dropdown (localStorage-backed, last 10)
     - Scroll-to-message on result click with highlight flash
     - Infinite scroll pagination (10 groups per page)
     - Multi-window awareness (via webviewHost bridge)
  3. Reuse the sidebar model resolver and logo for recent and searched conversations.
-->
<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { getContext, onDestroy, onMount, tick } from 'svelte';
	const i18n = getContext('i18n');

	import Modal from '$lib/components/common/Modal.svelte';
	import { getChatById, getChatList, getChatListBySearchText } from '$lib/apis/chats';
	import {
		ChatSearchRequestError,
		searchChatMessages
	} from '$lib/apis/chatSearch';
	import type {
		ChatMessageSearchResult,
		ChatSearchIndexStatus,
		MessageMatch
	} from '$lib/apis/chatSearch';
	import Spinner from '../common/Spinner.svelte';

	import dayjs from '$lib/dayjs';
	import localizedFormat from 'dayjs/plugin/localizedFormat';
	import calendar from 'dayjs/plugin/calendar';
	import Loader from '../common/Loader.svelte';
	import Tooltip from '../common/Tooltip.svelte';
	import { createMessagesList } from '$lib/utils';
	import { normalizeSelectedModelIds } from '$lib/utils/modelSelection';
	import { revealMessageWithRetry } from '$lib/utils/messageNavigation';
	import { resolveSidebarChatModelId } from '$lib/utils/chatSidebarModel';
	import { user } from '$lib/stores';
	import Messages from '../chat/Messages.svelte';
	import SidebarModelLogo from './Sidebar/SidebarModelLogo.svelte';
	import { goto } from '$app/navigation';
	dayjs.extend(calendar);
	dayjs.extend(localizedFormat);

	export let show = false;
	export let onClose = () => {};

	const SEARCH_HISTORY_KEY = 'portico-search-history';
	const LAST_QUERY_KEY = 'portico-search-last-query';
	const MAX_HISTORY = 10;
	const SEARCH_TYPING_DEBOUNCE_MS = 120;
	const PARTIAL_INDEX_REFRESH_DELAY_MS = 1400;
	const PREVIEW_SCROLL_RETRY_INTERVAL_MS = 150;
	const PREVIEW_SCROLL_MAX_ATTEMPTS = 12;
	const SEARCH_HIGHLIGHT_DURATION_MS = 2000;

	let query = loadLastQuery();
	let page = 1;

	let chatList: any[] | null = null;
	let messageResults: ChatMessageSearchResult[] = [];
	let hasMoreMessages = false;
	let nextCursor: string | null = null;
	let regexBudgetExhausted = false;
	let messageSearchLoading = false;
	let messageSearchError: string | null = null;
	let messageSearchIndexStatus: ChatSearchIndexStatus | null = null;

	let chatListLoading = false;
	let allChatsLoaded = false;

	let searchDebounceTimeout: ReturnType<typeof setTimeout> | undefined;
	let indexRefreshTimeout: ReturnType<typeof setTimeout> | undefined;

	let selectedIdx: number | null = null;
	let selectedKey: string | null = null;
	let lastInteraction: 'keyboard' | 'mouse' = 'keyboard';
	let selectedChat: any = null;
	let selectedChatId: string | null = null;
	let selectedMessageId: string | null = null;

	let selectedModels = [''];
	let history: any = null;
	let messages: any = null;
	let previewMessagesCount: number | null = null;

	// Search options
	let caseSensitive = false;
	let regexMode = false;
	let activeScopeKey: string | null = null;
	let activeRole: string | null = null;

	// Search history
	interface SearchHistoryEntry {
		query: string;
		timestamp: number;
	}
	let searchHistory: SearchHistoryEntry[] = [];
	let selectedHistoryIdx: number | null = null;
	let searchInputFocused = false;
	let blurTimeout: ReturnType<typeof setTimeout> | null = null;
	let searchInputEl: HTMLInputElement | null = null;
	let searchRequestSeq = 0;

	const isLocalFindActive = () =>
		document.documentElement?.dataset?.porticoLocalFindActive === 'true';

	const handleLocalFindVisibilityChange = (event: Event) => {
		const active = (event as CustomEvent<{ active?: boolean }>).detail?.active === true;
		if (active) {
			searchInputFocused = false;
			searchInputEl?.blur();
			show = false;
			return;
		}

		if (show) {
			void tick().then(() => {
				if (!isLocalFindActive()) {
					searchInputEl?.focus();
					searchInputFocused = true;
				}
			});
		}
	};

	type SearchResult = {
		chatId: string;
		chatTitle: string;
		chatTitleHtml: string;
		updatedAt: number;
		modelId: string | null;
		matchCount: number;
		matches: MessageMatch[];
		titleMatched: boolean;
	};

	type SearchSelectionTarget = {
		key: string;
		kind: 'chat' | 'message';
		chatId: string;
		chatTitle: string;
		messageId?: string;
	};

	let searchResults: SearchResult[] = [];
	let selectableSearchResults: SearchSelectionTarget[] = [];

	function loadSearchHistory(): SearchHistoryEntry[] {
		try {
			const stored = localStorage.getItem(SEARCH_HISTORY_KEY);
			if (!stored) return [];
			const parsed = JSON.parse(stored);
			if (!Array.isArray(parsed)) return [];
			return parsed.map((entry: unknown) => {
				if (typeof entry === 'string') {
					return { query: entry, timestamp: Date.now() };
				}
				if (entry && typeof entry === 'object' && 'query' in entry) {
					return entry as SearchHistoryEntry;
				}
				return null;
			}).filter((e): e is SearchHistoryEntry => e !== null);
		} catch {
			return [];
		}
	}

	function saveSearchHistory(q: string) {
		if (!q.trim()) return;
		const entry: SearchHistoryEntry = { query: q, timestamp: Date.now() };
		searchHistory = [entry, ...searchHistory.filter((h) => h.query !== q)].slice(0, MAX_HISTORY);
		persistHistory();
	}

	function commitCurrentSearchToHistory() {
		const q = query.trim();
		if (!q) return;
		saveSearchHistory(q);
	}

	function removeSearchHistoryItem(q: string) {
		searchHistory = searchHistory.filter((h) => h.query !== q);
		persistHistory();
	}

	function clearAllSearchHistory() {
		searchHistory = [];
		persistHistory();
	}

	function persistHistory() {
		try {
			localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(searchHistory));
		} catch {}
	}

	function loadLastQuery(): string {
		try {
			return localStorage.getItem(LAST_QUERY_KEY) ?? '';
		} catch {
			return '';
		}
	}

	function persistLastQuery(q: string) {
		try {
			localStorage.setItem(LAST_QUERY_KEY, q);
		} catch {}
	}

	const scopeFilters = [
		{ key: null, label: 'All' },
		{ key: 'today', label: 'Today' },
		{ key: 'week', label: 'Last 7 days' },
		{ key: 'month', label: 'Last 30 days' }
	];

	function getScopeTimestamp(key: string | null): number | undefined {
		if (!key) return undefined;
		const now = dayjs();
		switch (key) {
			case 'today':
				return now.startOf('day').unix();
			case 'week':
				return now.subtract(7, 'day').startOf('day').unix();
			case 'month':
				return now.subtract(30, 'day').startOf('day').unix();
			default:
				return undefined;
		}
	}

	const roleFilters = [
		{ key: null, label: 'All Messages' },
		{ key: 'user', label: 'My Messages' },
		{ key: 'assistant', label: 'AI Responses' }
	];

	$: persistLastQuery(query);
	$: hasActiveQuery = query.trim().length > 0;
	$: showSuggestionsPanel =
		searchInputFocused && !hasActiveQuery && searchHistory.length > 0;
	$: if (!showSuggestionsPanel) selectedHistoryIdx = null;
	$: searchResults = buildSearchResults(messageResults);
	$: selectableSearchResults = buildSelectableSearchResults(searchResults);
	$: {
		void selectableSearchResults;
		void chatList;
		reconcileSelectedKey();
	}
	$: searchSummaryText = getSearchSummaryText(searchResults);

	function getSearchResultItemCount() {
		return selectableSearchResults.length;
	}

	function getMessageSearchErrorMessage(error: unknown): string {
		if (error instanceof ChatSearchRequestError && error.message.trim()) {
			return error.message.trim();
		}

		if (
			typeof error === 'object' &&
			error !== null &&
			'message' in error &&
			typeof error.message === 'string' &&
			error.message.trim()
		) {
			return error.message.trim();
		}

		return $i18n.t('Failed to search conversations. Please try again.');
	}

	function clearIndexRefreshTimeout() {
		if (indexRefreshTimeout) {
			clearTimeout(indexRefreshTimeout);
			indexRefreshTimeout = undefined;
		}
	}

	function getIndexStatusLabel(status: ChatSearchIndexStatus | null) {
		if (!status?.partial) {
			return '';
		}

		if (status.total_chats > 0) {
			return $i18n.t('Indexing conversations... {{indexed}}/{{total}} indexed. Results may be partial.', {
				indexed: status.indexed_chats,
				total: status.total_chats
			});
		}

		return $i18n.t('Indexing conversations... results may be partial.');
	}

	function schedulePartialIndexRefresh(expectedQuery: string) {
		clearIndexRefreshTimeout();
		if (!messageSearchIndexStatus?.partial || !expectedQuery.trim()) {
			return;
		}

		indexRefreshTimeout = setTimeout(() => {
			indexRefreshTimeout = undefined;
			void refreshPartialMessageResults(expectedQuery);
		}, PARTIAL_INDEX_REFRESH_DELAY_MS);
	}

	async function refreshPartialMessageResults(expectedQuery: string) {
		if (!show || query.trim() !== expectedQuery.trim() || !hasActiveQuery || messageSearchLoading) {
			return;
		}

		try {
			const res = await searchChatMessages(localStorage.token, {
				text: expectedQuery,
				role: activeRole ?? undefined,
				updated_since: getScopeTimestamp(activeScopeKey),
				case_sensitive: caseSensitive,
				regex: regexMode
			});

			if (!show || query.trim() !== expectedQuery.trim()) {
				return;
			}

			messageResults = res.results;
			hasMoreMessages = res.has_more;
			nextCursor = res.next_cursor;
			regexBudgetExhausted = res.regex_budget_exhausted;
			messageSearchIndexStatus = res.index_status;
			allChatsLoaded = messageResults.length === 0;
			schedulePartialIndexRefresh(expectedQuery);
		} catch {
			// Keep the visible result set stable; explicit searches still surface failures.
		}
	}

	function getSearchSummaryText(results: SearchResult[]) {
		const messageMatchCount = results.reduce((sum, r) => sum + r.matchCount, 0);
		const matchLabel = messageMatchCount === 1 ? 'match' : 'matches';
		const convLabel = results.length === 1 ? 'conversation' : 'conversations';
		const suffix = hasMoreMessages ? '+' : '';
		return `${messageMatchCount}${suffix} ${matchLabel} across ${results.length}${suffix} ${convLabel}`;
	}

	function isCurrentSearchRequest(requestId: number, requestedQuery: string) {
		return show && searchRequestSeq === requestId && query.trim() === requestedQuery;
	}

	function escapeHtml(value: string) {
		return value
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	function normalizeUpdatedAt(value: unknown) {
		const timestamp = Number(value);
		if (!Number.isFinite(timestamp) || timestamp <= 0) {
			return Math.floor(Date.now() / 1000);
		}
		return timestamp > 1_000_000_000_000 ? Math.floor(timestamp / 1000) : timestamp;
	}

	function buildSearchResults(messageSearchResults: ChatMessageSearchResult[]) {
		return (messageSearchResults ?? []).map((result) => ({
			chatId: result.chat_id,
			chatTitle: result.title?.trim() || 'Untitled conversation',
			chatTitleHtml: result.title_html || escapeHtml(result.title?.trim() || 'Untitled conversation'),
			updatedAt: normalizeUpdatedAt(result.updated_at),
			modelId: result.model_id ?? null,
			matchCount: result.match_count,
			matches: result.matches,
			titleMatched: result.title_matched
		}));
	}

	function buildSelectableSearchResults(results: SearchResult[]) {
		const items: SearchSelectionTarget[] = [];

		results.forEach((result) => {
			items.push({
				key: `${result.chatId}:chat`,
				kind: 'chat',
				chatId: result.chatId,
				chatTitle: result.chatTitle
			});

			result.matches.forEach((match, matchIdx) => {
				items.push({
					key: `${result.chatId}:${match.message_id}:${matchIdx}`,
					kind: 'message',
					chatId: result.chatId,
					chatTitle: result.chatTitle,
					messageId: match.message_id
				});
			});
		});

		return items;
	}

	function resetChatPreview() {
		selectedChat = null;
		selectedChatId = null;
		selectedMessageId = null;
		messages = null;
		history = null;
		selectedModels = [''];
		previewMessagesCount = null;
	}

	function scrollChatPreviewToTop(chatId: string) {
		if (selectedChatId !== chatId) {
			return;
		}

		const messagesContainerElement = document.getElementById('chat-preview');
		messagesContainerElement?.scrollTo({
			top: 0,
			behavior: 'auto'
		});
	}

	function scrollChatPreviewToMessage(chatId: string, messageId: string, attempts = 0) {
		if (selectedChatId !== chatId || selectedMessageId !== messageId) {
			return;
		}

		const container = document.getElementById('chat-preview');
		if (!container) {
			return;
		}

		const messageEl = container.querySelector(`[id="message-${messageId}"]`) as HTMLElement | null;
		if (!messageEl) {
			if (attempts < PREVIEW_SCROLL_MAX_ATTEMPTS) {
				window.setTimeout(
					() => scrollChatPreviewToMessage(chatId, messageId, attempts + 1),
					PREVIEW_SCROLL_RETRY_INTERVAL_MS
				);
			}
			return;
		}

		const containerRect = container.getBoundingClientRect();
		const elementRect = messageEl.getBoundingClientRect();
		const scrollTop = container.scrollTop + (elementRect.top - containerRect.top) - 96;
		container.scrollTo({ top: Math.max(0, scrollTop), behavior: 'auto' });

		messageEl.classList.remove('search-highlight-flash');
		void messageEl.offsetWidth;
		messageEl.classList.add('search-highlight-flash');
		window.setTimeout(() => {
			messageEl.classList.remove('search-highlight-flash');
		}, SEARCH_HIGHLIGHT_DURATION_MS);
	}

	const loadChatPreview = async (chatId: string | null, messageId?: string) => {
		if (!chatId) {
			resetChatPreview();
			return;
		}

		if (hasActiveQuery) {
			commitCurrentSearchToHistory();
		}

		selectedChatId = chatId;
		selectedMessageId = messageId ?? null;
		selectedChat = null;
		messages = null;
		history = null;
		selectedModels = [''];
		const chat = await getChatById(localStorage.token, chatId).catch(async () => {
			return null;
		});

		if (selectedChatId !== chatId) {
			return;
		}

		if (chat) {
			selectedChat = chat;
			if (chat?.chat?.history) {
				selectedModels = normalizeSelectedModelIds(
					(chat?.chat?.models ?? undefined) !== undefined ? chat.chat.models : chat.chat.model
				);
				if (selectedModels.length === 0) {
					selectedModels = [''];
				}

				history = chat?.chat?.history;
				messages = createMessagesList(chat?.chat?.history, chat?.chat?.history?.currentId);

				if (messageId && messages) {
					const matchIndex = messages.findIndex((m) => m.id === messageId);
					const needed = matchIndex >= 0 ? messages.length - matchIndex + 5 : 20;
					previewMessagesCount = Math.max(20, needed);
				} else {
					previewMessagesCount = null;
				}

				await tick();
				if (messageId) {
					scrollChatPreviewToMessage(chatId, messageId);
				} else {
					scrollChatPreviewToTop(chatId);
					window.requestAnimationFrame(() => {
						scrollChatPreviewToTop(chatId);
					});
				}
			} else {
				messages = [];
			}
		} else {
			toast.error($i18n.t('Failed to load chat preview'));
			resetChatPreview();
			return;
		}
	};

	const searchHandler = async ({ immediate = false }: { immediate?: boolean } = {}) => {
		if (!show) {
			return;
		}

		if (searchDebounceTimeout) {
			clearTimeout(searchDebounceTimeout);
		}
		clearIndexRefreshTimeout();

		page = 1;
		hasMoreMessages = false;
		nextCursor = null;
		regexBudgetExhausted = false;
		messageSearchError = null;
		messageSearchIndexStatus = null;
		messageSearchLoading = false;
		selectedIdx = null;
		selectedKey = null;
		const requestedQuery = query.trim();
		const requestId = ++searchRequestSeq;

		if (requestedQuery === '') {
			searchDebounceTimeout = undefined;
			messageResults = [];
			chatList = await getChatList(localStorage.token, page);
			resetChatPreview();

			if ((chatList ?? []).length === 0) {
				allChatsLoaded = true;
			} else {
				allChatsLoaded = false;
			}
			return;
		}

		chatList = null;
		searchDebounceTimeout = setTimeout(() => {
			searchDebounceTimeout = undefined;
			messageSearchLoading = true;
			messageSearchError = null;

			void (async () => {
				try {
					const res = await searchChatMessages(localStorage.token, {
						text: requestedQuery,
						role: activeRole ?? undefined,
						updated_since: getScopeTimestamp(activeScopeKey),
						case_sensitive: caseSensitive,
						regex: regexMode
					});

					if (!isCurrentSearchRequest(requestId, requestedQuery)) {
						return;
					}

					messageResults = res.results;
					hasMoreMessages = res.has_more;
					nextCursor = res.next_cursor;
					regexBudgetExhausted = res.regex_budget_exhausted;
					messageSearchIndexStatus = res.index_status;
					allChatsLoaded = messageResults.length === 0;
					schedulePartialIndexRefresh(requestedQuery);
				} catch (error) {
					if (!isCurrentSearchRequest(requestId, requestedQuery)) {
						return;
					}
					messageResults = [];
					hasMoreMessages = false;
					nextCursor = null;
					messageSearchIndexStatus = null;
					allChatsLoaded = false;
					messageSearchError = getMessageSearchErrorMessage(error);
				} finally {
					if (isCurrentSearchRequest(requestId, requestedQuery)) {
						messageSearchLoading = false;
					}
				}
			})();
		}, immediate ? 0 : SEARCH_TYPING_DEBOUNCE_MS);

		resetChatPreview();
	};

	const loadMoreMessages = async () => {
		if (chatListLoading || !hasActiveQuery || !nextCursor) return;
		chatListLoading = true;

		try {
			const res = await searchChatMessages(localStorage.token, {
				text: query,
				cursor: nextCursor,
				role: activeRole ?? undefined,
				updated_since: getScopeTimestamp(activeScopeKey),
				case_sensitive: caseSensitive,
				regex: regexMode
			});

			hasMoreMessages = res.has_more;
			nextCursor = res.next_cursor;
			regexBudgetExhausted = res.regex_budget_exhausted;
			messageSearchIndexStatus = res.index_status;
			if (res.results.length > 0) {
				messageResults = [...messageResults, ...res.results];
			} else {
				allChatsLoaded = true;
			}
			schedulePartialIndexRefresh(query.trim());
		} catch (error) {
			toast.error(getMessageSearchErrorMessage(error));
		} finally {
			chatListLoading = false;
		}
	};

	const loadMoreChats = async () => {
		chatListLoading = true;
		page += 1;

		let newChatList: any[] = [];

		if (query) {
			newChatList = await getChatListBySearchText(localStorage.token, query, page);
		} else {
			newChatList = await getChatList(localStorage.token, page);
		}

		allChatsLoaded = newChatList.length === 0;

		if (newChatList.length > 0) {
			chatList = [...(chatList ?? []), ...newChatList];
		}

		chatListLoading = false;
	};

	async function navigateToMessage(
		chatId: string,
		messageId: string,
		options: { chatTitle?: string | null } = {}
	) {
		commitCurrentSearchToHistory();
		let handled = false;
		if (typeof window !== 'undefined' && (window as any).webviewHost?.navigateToConversation) {
			try {
				handled = await (window as any).webviewHost.navigateToConversation(chatId, messageId, {
					title: options.chatTitle ?? undefined
				});
			} catch {}
		}

		if (!handled) {
			await goto(`/c/${chatId}`);
			revealMessageWithRetry(messageId);
		}

		show = false;
		onClose();
	}

	async function navigateToChat(chatId: string, options: { chatTitle?: string | null } = {}) {
		commitCurrentSearchToHistory();
		let handled = false;
		if (typeof window !== 'undefined' && (window as any).webviewHost?.navigateToConversation) {
			try {
				handled = await (window as any).webviewHost.navigateToConversation(chatId, undefined, {
					title: options.chatTitle ?? undefined
				});
			} catch {}
		}

		if (!handled) {
			await goto(`/c/${chatId}`);
		}

		show = false;
		onClose();
	}

	async function activateSearchSelection(target: SearchSelectionTarget) {
		await loadChatPreview(target.chatId, target.messageId);
	}

	function getTimeRangeLabel(updatedAt: number): string {
		const now = dayjs();
		const d = dayjs(updatedAt * 1000);
		if (d.isSame(now, 'day')) return 'Today';
		if (d.isSame(now.subtract(1, 'day'), 'day')) return 'Yesterday';
		if (d.isAfter(now.subtract(7, 'day'))) return 'Last 7 days';
		if (d.isAfter(now.subtract(30, 'day'))) return 'Last 30 days';
		return d.format('MMMM YYYY');
	}

	$: if (typeof window !== 'undefined') {
		window.dispatchEvent(
			new CustomEvent('portico-global-search-visibility-changed', { detail: { active: show } })
		);
	}

	function onSearchOpen() {
		searchHistory = loadSearchHistory();
		query = loadLastQuery();
		searchHandler();
		tick().then(() => {
			if (!isLocalFindActive()) {
				searchInputEl?.focus();
				searchInputEl?.select();
				searchInputFocused = true;
			}
		});
	}

	$: if (show) {
		onSearchOpen();
	} else {
		searchInputFocused = false;
		clearIndexRefreshTimeout();
	}

	function onFilterChange() {
		if (hasActiveQuery) {
			searchHandler({ immediate: true });
		}
	}

	function handleSearchInputFocus() {
		if (isLocalFindActive()) {
			searchInputFocused = false;
			searchInputEl?.blur();
			return;
		}
		if (blurTimeout !== null) {
			clearTimeout(blurTimeout);
			blurTimeout = null;
		}
		setSelectedByIndex(null);
		searchInputFocused = true;
	}

	function handleSearchInputBlur() {
		blurTimeout = window.setTimeout(() => {
			searchInputFocused = false;
			blurTimeout = null;
		}, 150);
	}

	function clearSearchInput() {
		query = '';
		searchInputFocused = true;
		void searchHandler({ immediate: true });
		void tick().then(() => {
			if (!isLocalFindActive()) {
				searchInputEl?.focus();
			}
		});
	}

	function selectHistoryItem(item: string | SearchHistoryEntry) {
		query = typeof item === 'string' ? item : item.query;
		selectedHistoryIdx = null;
		searchInputFocused = false;
		void searchHandler({ immediate: true });
	}

	function navigateToSelectedTarget(target: SearchSelectionTarget) {
		if (target.kind === 'message' && target.messageId) {
			void navigateToMessage(target.chatId, target.messageId, { chatTitle: target.chatTitle });
		} else {
			void navigateToChat(target.chatId, { chatTitle: target.chatTitle });
		}
	}

	function getSelectedTarget(): { target: SearchSelectionTarget; previewed: boolean } | null {
		const idx = selectedIdx ?? 0;

		if (hasActiveQuery && idx < selectableSearchResults.length) {
			const target = selectableSearchResults[idx];
			if (!target) return null;
			const chatMatch = selectedChatId === target.chatId;
			const previewed = target.kind === 'message' && target.messageId
				? chatMatch && selectedMessageId === target.messageId
				: chatMatch && selectedMessageId === null;
			return { target, previewed };
		}

		if (!hasActiveQuery && chatList && idx < chatList.length) {
			const chat = chatList[idx];
			if (!chat?.id) return null;
			const target: SearchSelectionTarget = {
				key: `${chat.id}:chat`,
				kind: 'chat',
				chatId: chat.id,
				chatTitle: chat.title ?? ''
			};
			return { target, previewed: selectedChatId === chat.id };
		}

		return null;
	}

	async function scrollSelectedItemIntoView() {
		await tick();
		const item = document.querySelector(`[data-arrow-selected="true"]`);
		(item as HTMLElement)?.scrollIntoView({
			block: 'center',
			inline: 'nearest',
			behavior: 'instant' as ScrollBehavior
		});
	}

	function setSelectedByIndex(idx: number | null) {
		if (idx === null || idx < 0) {
			selectedIdx = null;
			selectedKey = null;
			return;
		}
		selectedIdx = idx;
		if (hasActiveQuery) {
			selectedKey = selectableSearchResults[idx]?.key ?? null;
		} else {
			selectedKey = (chatList ?? [])[idx]?.id ?? null;
		}
	}

	function setSelectedByKey(key: string) {
		if (hasActiveQuery) {
			const idx = selectableSearchResults.findIndex((r) => r.key === key);
			if (idx >= 0) {
				selectedIdx = idx;
				selectedKey = key;
			}
		}
	}

	function reconcileSelectedKey() {
		if (selectedKey === null) {
			return;
		}
		if (hasActiveQuery) {
			const idx = selectableSearchResults.findIndex((r) => r.key === selectedKey);
			selectedIdx = idx >= 0 ? idx : null;
			if (selectedIdx === null) selectedKey = null;
		} else if (chatList) {
			const idx = chatList.findIndex((c: any) => c.id === selectedKey);
			selectedIdx = idx >= 0 ? idx : null;
			if (selectedIdx === null) selectedKey = null;
		}
	}

	const onKeyDown = (e: KeyboardEvent) => {
		if (!show || isLocalFindActive()) {
			return;
		}

		const inputFocused = document.activeElement === searchInputEl;

		if (e.code === 'Escape') {
			e.preventDefault();
			selectedHistoryIdx = null;
			show = false;
			onClose();
		} else if (e.code === 'Enter') {
			e.preventDefault();
			e.stopPropagation();

			if (showSuggestionsPanel && selectedHistoryIdx !== null) {
				const historyEntry = searchHistory[selectedHistoryIdx];
				if (historyEntry) {
					selectHistoryItem(historyEntry);
				}
			} else if (inputFocused && hasActiveQuery && searchDebounceTimeout) {
				commitCurrentSearchToHistory();
				void searchHandler({ immediate: true });
			} else {
				if (hasActiveQuery) {
					commitCurrentSearchToHistory();
				}

				if (selectedIdx === null && selectableSearchResults.length > 0) {
					setSelectedByIndex(0);
				}
				const selected = getSelectedTarget();
				if (selected?.previewed) {
					navigateToSelectedTarget(selected.target);
				} else {
					const arrowItem = document.querySelector(`[data-arrow-selected="true"]`);
					if (arrowItem) {
						(arrowItem as HTMLElement)?.click();
					} else if (selected) {
						activateSearchSelection(selected.target);
					}
				}
			}
		} else if (e.code === 'ArrowDown') {
			e.preventDefault();
			lastInteraction = 'keyboard';

			if (showSuggestionsPanel) {
				selectedHistoryIdx =
					selectedHistoryIdx === null || selectedHistoryIdx >= searchHistory.length - 1
						? 0
						: selectedHistoryIdx + 1;
			} else {
				const totalItems = hasActiveQuery ? getSearchResultItemCount() : (chatList ?? []).length;
				if (totalItems > 0) {
					setSelectedByIndex(Math.min((selectedIdx ?? -1) + 1, totalItems - 1));
				}
				void scrollSelectedItemIntoView();
			}
		} else if (e.code === 'ArrowUp') {
			e.preventDefault();
			lastInteraction = 'keyboard';

			if (showSuggestionsPanel) {
				selectedHistoryIdx =
					selectedHistoryIdx === null || selectedHistoryIdx <= 0
						? searchHistory.length - 1
						: selectedHistoryIdx - 1;
			} else {
				setSelectedByIndex(Math.max((selectedIdx ?? 0) - 1, 0));
				void scrollSelectedItemIntoView();
			}
		} else if (showSuggestionsPanel && (e.code === 'Delete' || e.code === 'Backspace') && selectedHistoryIdx !== null) {
			e.preventDefault();
			const removedIdx = selectedHistoryIdx;
			removeSearchHistoryItem(searchHistory[removedIdx].query);
			if (searchHistory.length === 0) {
				selectedHistoryIdx = null;
			} else if (removedIdx >= searchHistory.length) {
				selectedHistoryIdx = searchHistory.length - 1;
			}
		}
	};

	onMount(() => {
		document.addEventListener('keydown', onKeyDown);
		window.addEventListener(
			'portico-local-find-visibility-changed',
			handleLocalFindVisibilityChange as EventListener
		);
	});

	onDestroy(() => {
		if (searchDebounceTimeout) {
			clearTimeout(searchDebounceTimeout);
		}
		clearIndexRefreshTimeout();
		document.removeEventListener('keydown', onKeyDown);
		window.removeEventListener(
			'portico-local-find-visibility-changed',
			handleLocalFindVisibilityChange as EventListener
		);
	});
</script>

<style>
	:global(.search-highlight-flash) {
		animation: highlight-flash 2s ease-out;
	}

	@keyframes highlight-flash {
		0% {
			background-color: rgba(250, 204, 21, 0.4);
		}
		100% {
			background-color: transparent;
		}
	}

	.filter-pill {
		cursor: pointer;
		padding: 0.25rem 0.625rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		font-weight: 500;
		border: 1px solid var(--portico-search-border-muted, rgba(148, 163, 184, 0.24));
		background: transparent;
		transition: all 0.15s ease;
		white-space: nowrap;
	}

	.filter-pill.active {
		background-color: var(--portico-accent-fill, rgba(79, 148, 255, 0.16));
		color: var(--portico-accent-text, #4f94ff);
		border-color: var(--portico-accent-border, rgba(79, 148, 255, 0.3));
	}

	.filter-pill:not(.active) {
		color: var(--portico-search-muted, rgba(100, 116, 139, 0.88));
	}

	.filter-pill:not(.active):hover {
		background-color: var(--portico-search-surface-hover, rgba(79, 148, 255, 0.08));
	}

	.toggle-btn {
		cursor: pointer;
		padding: 0.25rem 0.375rem;
		border-radius: 0.375rem;
		font-size: 0.6875rem;
		font-weight: 600;
		font-family: 'SF Mono', 'Fira Code', monospace;
		border: 1px solid var(--portico-search-border-muted, rgba(148, 163, 184, 0.24));
		background: transparent;
		transition: all 0.15s ease;
		min-width: 1.75rem;
		text-align: center;
	}

	.toggle-btn.active {
		background-color: var(--portico-accent-fill, rgba(79, 148, 255, 0.16));
		color: var(--portico-accent-text, #4f94ff);
		border-color: var(--portico-accent-border, rgba(79, 148, 255, 0.3));
	}

	.toggle-btn:not(.active) {
		color: var(--portico-search-muted, rgba(100, 116, 139, 0.88));
	}

	.toggle-btn:not(.active):hover {
		color: var(--portico-search-text, #0f172a);
		background-color: var(--portico-search-surface-hover, rgba(79, 148, 255, 0.08));
	}

	.search-input-shell {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.4rem 0.75rem;
		border-radius: 0.95rem;
		border: 1px solid var(--portico-search-border-muted, rgba(148, 163, 184, 0.24));
		background: var(--portico-search-surface, rgba(255, 255, 255, 0.96));
		box-shadow: var(--portico-search-shadow, 0 16px 36px rgba(15, 23, 42, 0.12));
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease,
			background-color 0.15s ease;
	}

	.search-input-shell:focus-within {
		border-color: var(--portico-accent-border, rgba(79, 148, 255, 0.3));
		box-shadow:
			0 0 0 3px var(--portico-accent-fill, rgba(79, 148, 255, 0.16)),
			var(--portico-search-shadow, 0 16px 36px rgba(15, 23, 42, 0.12));
	}

	.search-input-icon {
		color: var(--portico-search-muted, rgba(100, 116, 139, 0.88));
		font-size: 0.85rem;
		line-height: 1;
	}

	.search-input {
		flex: 1 1 auto;
		min-width: 0;
		border: none;
		outline: none;
		background: transparent;
		color: var(--portico-search-text, #0f172a);
		font-size: 0.95rem;
		line-height: 1.4;
	}

	.search-input::placeholder {
		color: var(--portico-search-muted, rgba(100, 116, 139, 0.88));
	}

	.search-input-clear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.65rem;
		height: 1.65rem;
		border: 1px solid transparent;
		border-radius: 999px;
		background: transparent;
		color: var(--portico-search-muted, rgba(100, 116, 139, 0.88));
		cursor: pointer;
		transition:
			background-color 0.15s ease,
			color 0.15s ease,
			border-color 0.15s ease;
	}

	.search-input-clear:hover {
		background: var(--portico-search-surface-hover, rgba(79, 148, 255, 0.08));
		color: var(--portico-search-text, #0f172a);
	}

	.search-suggestions-panel {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		margin: 0.55rem 1rem 0;
		padding: 0.65rem;
		background: var(--portico-search-surface, rgba(255, 255, 255, 0.96));
		border: 1px solid var(--portico-search-border-muted, rgba(148, 163, 184, 0.24));
		border-radius: 0.95rem;
		box-shadow: var(--portico-search-shadow, 0 16px 36px rgba(15, 23, 42, 0.12));
	}

	.search-suggestions-section {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.search-suggestions-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 0.15rem;
	}

	.search-suggestions-title {
		font-size: 0.625rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--portico-search-muted, rgba(100, 116, 139, 0.88));
	}

	.search-suggestion-clear-all {
		border: none;
		background: transparent;
		color: var(--portico-search-muted, rgba(100, 116, 139, 0.88));
		font-size: 0.625rem;
		font-weight: 500;
		cursor: pointer;
		padding: 0.1rem 0.25rem;
		border-radius: 0.25rem;
		transition: color 0.15s ease, background-color 0.15s ease;
	}

	.search-suggestion-clear-all:hover {
		color: var(--portico-search-text, #0f172a);
		background-color: var(--portico-search-surface-hover, rgba(79, 148, 255, 0.08));
	}

	.search-suggestion-item {
		display: flex;
		align-items: flex-start;
		gap: 0.65rem;
		width: 100%;
		padding: 0.55rem 0.65rem;
		border: 1px solid transparent;
		border-radius: 0.8rem;
		background: transparent;
		text-align: left;
		transition:
			background-color 0.15s ease,
			border-color 0.15s ease;
	}

	.search-history-row {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.search-history-button {
		flex: 1 1 auto;
	}

	.search-suggestion-item--history {
		cursor: pointer;
	}

	.search-suggestion-item--selected,
	.search-result-selected {
		background: var(--portico-search-surface-hover, rgba(79, 148, 255, 0.08)) !important;
		border-color: var(--portico-accent-border, rgba(79, 148, 255, 0.3));
	}

	.search-result-previewed {
		box-shadow: inset 3px 0 0 0 rgba(16, 185, 129, 0.7);
	}

	:global(.dark) .search-result-previewed {
		box-shadow: inset 3px 0 0 0 rgba(16, 185, 129, 0.8);
	}

	.search-results-pane button:focus {
		outline: none;
	}

	.search-suggestion-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.35rem;
		height: 1.35rem;
		border-radius: 999px;
		background: var(--portico-accent-fill, rgba(79, 148, 255, 0.16));
		color: var(--portico-accent-text, #4f94ff);
		font-size: 0.72rem;
		flex-shrink: 0;
	}

	.search-suggestion-label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--portico-search-text, #0f172a);
		font-size: 0.84rem;
		line-height: 1.25;
	}

	.search-suggestion-timestamp {
		flex-shrink: 0;
		margin-left: auto;
		color: var(--portico-search-muted, rgba(100, 116, 139, 0.88));
		font-size: 0.68rem;
		line-height: 1.25;
	}

	.search-suggestion-remove {
		border: 1px solid transparent;
		border-radius: 999px;
		background: transparent;
		color: var(--portico-search-muted, rgba(100, 116, 139, 0.88));
		cursor: pointer;
		font-size: 0.8rem;
		line-height: 1;
		padding: 0.1rem 0.2rem;
		transition:
			background-color 0.15s ease,
			color 0.15s ease;
	}

	.search-suggestion-remove:hover {
		background: var(--portico-search-surface-hover, rgba(79, 148, 255, 0.08));
		color: var(--portico-search-text, #0f172a);
	}

	.search-results-pane,
	.search-preview-pane {
		height: 26rem;
	}

	.search-preview-surface {
		background: #f8fafc;
		border-left: 1px solid rgba(148, 163, 184, 0.16);
	}

	.search-filter-row {
		padding-top: 0.35rem;
		padding-bottom: 0.75rem;
	}

	.search-index-status {
		margin: 0 0 0.75rem;
		padding: 0.4rem 0.55rem;
		border-radius: 0.55rem;
		border: 1px solid var(--portico-accent-border, rgba(79, 148, 255, 0.3));
		background: var(--portico-accent-fill, rgba(79, 148, 255, 0.12));
		color: var(--portico-accent-text, #4f94ff);
		font-size: 0.68rem;
		line-height: 1.35;
	}

	.search-inline-status {
		margin: 0 0 0.5rem;
		padding: 0 0.5rem;
		color: var(--portico-search-muted, rgba(100, 116, 139, 0.88));
		font-size: 0.68rem;
		line-height: 1.35;
	}

	:global(.light) .search-preview-surface {
		background:
			radial-gradient(circle at top, rgba(213, 220, 231, 0.44), transparent 33%),
			linear-gradient(180deg, #c5cdda 0%, #cdd4e0 28%, #c5cdd9 100%);
	}

	:global(.dark) .search-preview-surface {
		background: #171717;
		border-left-color: rgba(75, 85, 99, 0.3);
	}

	@media (min-width: 768px) {
		.search-results-pane,
		.search-preview-pane {
			height: 44rem;
		}
	}

	:global(.snippet-text mark) {
		background-color: rgba(250, 204, 21, 0.4);
		color: inherit;
		padding: 0 1px;
		border-radius: 2px;
	}

	:global(.search-result-title mark) {
		background-color: rgba(250, 204, 21, 0.4);
		color: inherit;
		padding: 0 1px;
		border-radius: 2px;
	}
</style>

<Modal size="2xl" bind:show>
	<div class="py-3 dark:text-gray-300 text-gray-700">
		<div class="px-4 pb-1.5">
			<div class="flex items-center gap-2">
				<div class="flex-1">
					<div class="search-input-shell">
						<span class="search-input-icon" aria-hidden="true">&#128269;</span>
						<input
							bind:this={searchInputEl}
							bind:value={query}
							id="search-input"
							class="search-input"
							type="text"
							spellcheck="false"
							autocomplete="off"
							placeholder={$i18n.t('Search chats and messages...')}
							on:focus={handleSearchInputFocus}
							on:blur={handleSearchInputBlur}
							on:input={() => {
								void searchHandler();
							}}
						/>
						{#if query.trim().length > 0}
							<button
								class="search-input-clear"
								type="button"
								aria-label={$i18n.t('Clear search')}
								on:mousedown|preventDefault
								on:click={clearSearchInput}
							>
								&times;
							</button>
						{/if}
					</div>
				</div>

				<div class="flex items-center gap-1 shrink-0">
					<Tooltip content={$i18n.t('Match capitalization exactly')} placement="bottom">
						<button
							class="toggle-btn"
							class:active={caseSensitive}
							type="button"
							aria-label={$i18n.t('Match capitalization exactly')}
							on:click={() => {
								caseSensitive = !caseSensitive;
								onFilterChange();
							}}
						>
							Aa
						</button>
					</Tooltip>
					<Tooltip content={$i18n.t('Use regular expression syntax')} placement="bottom">
						<button
							class="toggle-btn"
							class:active={regexMode}
							type="button"
							aria-label={$i18n.t('Use regular expression syntax')}
							on:click={() => {
								regexMode = !regexMode;
								onFilterChange();
							}}
						>
							.*
						</button>
					</Tooltip>
				</div>
			</div>
		</div>

		{#if showSuggestionsPanel}
			<div class="search-suggestions-panel">
				<div class="search-suggestions-section">
					<div class="search-suggestions-header">
					<div class="search-suggestions-title">Recent Searches</div>
					<button
						class="search-suggestion-clear-all"
						type="button"
						on:mousedown|preventDefault={clearAllSearchHistory}
					>
						Clear all
					</button>
				</div>
					{#each searchHistory as historyEntry, historyIdx}
						<div class="search-history-row">
							<button
								class="search-suggestion-item search-suggestion-item--history search-history-button"
								class:search-suggestion-item--selected={selectedHistoryIdx === historyIdx}
								type="button"
								on:mousedown|preventDefault={() => {
									selectHistoryItem(historyEntry);
								}}
							>
								<span class="search-suggestion-icon" aria-hidden="true">&#128269;</span>
								<span class="search-suggestion-label">{historyEntry.query}</span>
								<span class="search-suggestion-timestamp">{dayjs(historyEntry.timestamp).fromNow()}</span>
							</button>
							<button
								class="search-suggestion-remove"
								type="button"
								title="Remove"
								on:mousedown|preventDefault|stopPropagation={() => {
									removeSearchHistoryItem(historyEntry.query);
								}}
							>
								&times;
							</button>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		{#if hasActiveQuery}
			<div class="search-filter-row px-4 flex items-center gap-1.5 flex-wrap">
				{#each scopeFilters as filter}
					<button
						class="filter-pill"
						class:active={activeScopeKey === filter.key}
						on:click={() => {
							activeScopeKey = activeScopeKey === filter.key ? null : filter.key;
							onFilterChange();
						}}
					>
						{filter.label}
					</button>
				{/each}

				<span class="mx-1 text-gray-300 dark:text-gray-600">|</span>

				{#each roleFilters as filter}
					<button
						class="filter-pill"
						class:active={activeRole === filter.key}
						on:click={() => {
							activeRole = activeRole === filter.key ? null : filter.key;
							onFilterChange();
						}}
					>
						{filter.label}
					</button>
				{/each}
			</div>
		{/if}

		<div class="flex px-4 pb-1">
			<div
				class="search-results-pane flex flex-col overflow-y-auto max-h-full scrollbar-hidden w-full flex-1 pr-2"
				on:mousemove={(e) => { if (e.movementX || e.movementY) lastInteraction = 'mouse'; }}
			>
				{#if !hasActiveQuery}
					<!-- Default mode: show recent chats -->
					{#if chatList}
						{#if chatList.length === 0}
							<div class="text-xs text-gray-500 dark:text-gray-400 text-center px-5 py-4">
								{$i18n.t('No results found')}
							</div>
						{/if}

						{#each chatList as chat, idx (chat.id)}
							{#if idx === 0 || (idx > 0 && chat.time_range !== chatList[idx - 1].time_range)}
								<div
									class="w-full text-xs text-gray-500 dark:text-gray-500 font-medium {idx === 0
										? 'pt-2'
										: 'pt-5'} pb-2 px-2"
								>
									{$i18n.t(chat.time_range)}
								</div>
							{/if}

							<button
								type="button"
								class=" w-full flex justify-between items-center rounded-xl text-left text-sm py-2 px-3 border border-transparent transition-colors hover:bg-gray-50 dark:hover:bg-gray-850"
								class:search-result-selected={selectedIdx === idx}
								class:search-result-previewed={selectedChatId === chat.id}
								draggable="false"
								data-arrow-selected={selectedIdx === idx
									? 'true'
									: undefined}
								on:click={() => {
									if (selectedChatId === chat.id) {
										navigateToChat(chat.id, { chatTitle: chat?.title ?? null });
										return;
									}
									setSelectedByIndex(idx);
									void loadChatPreview(chat.id);
								}}
								on:dblclick={() => {
									navigateToChat(chat.id, {
										chatTitle: chat?.title ?? null
									});
								}}
							>
								<div class="flex flex-1 min-w-0 items-center gap-1.5">
									<SidebarModelLogo modelId={resolveSidebarChatModelId(chat)} />
									<div class="text-ellipsis line-clamp-1 w-full min-w-0">
										{chat?.title}
									</div>
								</div>

								<div class=" pl-3 shrink-0 text-gray-500 dark:text-gray-400 text-xs">
									{$i18n.t(
										dayjs(chat?.updated_at * 1000).calendar(null, {
											sameDay: '[Today]',
											nextDay: '[Tomorrow]',
											nextWeek: 'dddd',
											lastDay: '[Yesterday]',
											lastWeek: '[Last] dddd',
											sameElse: 'L'
										})
									)}
								</div>
							</button>
						{/each}

						{#if !allChatsLoaded}
							<Loader
								on:visible={() => {
									if (!chatListLoading) {
										loadMoreChats();
									}
								}}
							>
								<div
									class="w-full flex justify-center py-4 text-xs animate-pulse items-center gap-2"
								>
									<Spinner className=" size-4" />
									<div class=" ">{$i18n.t('Loading...')}</div>
								</div>
							</Loader>
						{/if}
					{:else}
						<div class="w-full h-full flex justify-center items-center">
							<Spinner className="size-5" />
						</div>
					{/if}
				{:else}
					<!-- Search results mode -->
					{#if messageSearchIndexStatus?.partial}
						<div class="search-index-status">
							{getIndexStatusLabel(messageSearchIndexStatus)}
						</div>
					{/if}

					{#if messageSearchError && searchResults.length === 0}
						<div class="px-5 py-8 flex flex-col items-center gap-3 text-center">
							<div class="text-xs text-rose-500 dark:text-rose-400">
								{messageSearchError}
							</div>
							<button
								class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-850 transition-colors"
								on:click={() => {
									searchHandler({ immediate: true });
								}}
							>
								Retry search
							</button>
						</div>
					{:else if searchResults.length === 0 && !searchDebounceTimeout && !messageSearchLoading}
						<div class="text-xs text-gray-500 dark:text-gray-400 text-center px-5 py-8">
							{$i18n.t('No results found')}
						</div>
					{:else if searchResults.length === 0}
						<div class="w-full h-full flex justify-center items-center">
							<Spinner className="size-5" />
						</div>
					{:else}
						{#if messageSearchError}
							<div class="search-inline-status text-rose-500 dark:text-rose-400">
								{messageSearchError}
								<button
									class="ml-2 underline underline-offset-2"
									type="button"
									on:click={() => {
										searchHandler({ immediate: true });
									}}
								>
									Retry
								</button>
							</div>
						{:else if messageSearchLoading}
							<div class="search-inline-status">
								{$i18n.t('Searching messages...')}
							</div>
						{/if}

						{#each searchResults as result, idx}
							{@const timeRange = getTimeRangeLabel(result.updatedAt)}
							{@const prevTimeRange =
								idx > 0 ? getTimeRangeLabel(searchResults[idx - 1].updatedAt) : null}

							{#if idx === 0 || timeRange !== prevTimeRange}
								<div
									class="w-full text-xs text-gray-500 dark:text-gray-500 font-medium {idx ===
									0
										? 'pt-2'
										: 'pt-5'} pb-2 px-2"
								>
									{timeRange}
								</div>
							{/if}

							{#if result.matches.length === 0}
								{@const itemKey = `${result.chatId}:chat`}
								<button
									type="button"
									class="w-full rounded-xl py-2 px-3 text-left border border-transparent transition-colors hover:bg-gray-50/70 dark:hover:bg-gray-850/70"
									class:search-result-selected={selectedKey === itemKey}
									class:search-result-previewed={selectedChatId === result.chatId && !selectedMessageId}
									data-arrow-selected={selectedKey === itemKey ? 'true' : undefined}
									on:mouseenter={() => {
										if (lastInteraction === 'mouse') setSelectedByKey(itemKey);
									}}
									on:click={() => {
										if (selectedChatId === result.chatId && !selectedMessageId) {
											navigateToChat(result.chatId, { chatTitle: result.chatTitle });
											return;
										}
										setSelectedByKey(itemKey);
										void loadChatPreview(result.chatId);
									}}
									on:dblclick={() => {
										navigateToChat(result.chatId, {
											chatTitle: result.chatTitle
										});
									}}
								>
									<div class="flex items-center justify-between gap-2">
										<div class="flex items-center gap-1.5 flex-1 min-w-0">
											<SidebarModelLogo modelId={result.modelId} />
											<div class="search-result-title text-sm font-medium text-ellipsis line-clamp-1 flex-1 min-w-0">
												{@html result.chatTitleHtml}
											</div>
										</div>
										<span class="text-xs text-gray-400 dark:text-gray-500 shrink-0">
											{dayjs(result.updatedAt * 1000).calendar(null, {
												sameDay: '[Today]',
												nextDay: '[Tomorrow]',
												nextWeek: 'dddd',
												lastDay: '[Yesterday]',
												lastWeek: '[Last] dddd',
												sameElse: 'L'
											})}
										</span>
									</div>
								</button>
							{:else}
								{@const titleKey = `${result.chatId}:chat`}
								<div
									class="w-full rounded-xl py-2 px-3 border border-transparent"
								>
									<button
										type="button"
										class="w-full flex items-center justify-between mb-1 text-left rounded-lg py-1 px-1 border border-transparent transition-colors hover:bg-gray-50/70 dark:hover:bg-gray-850/70"
										class:search-result-selected={selectedKey === titleKey}
										class:search-result-previewed={selectedChatId === result.chatId && !selectedMessageId}
										data-arrow-selected={selectedKey === titleKey ? 'true' : undefined}
										on:mouseenter={() => {
											if (lastInteraction === 'mouse') setSelectedByKey(titleKey);
										}}
										on:click={() => {
											if (selectedChatId === result.chatId && !selectedMessageId) {
												navigateToChat(result.chatId, { chatTitle: result.chatTitle });
												return;
											}
											setSelectedByKey(titleKey);
											void loadChatPreview(result.chatId);
										}}
										on:dblclick={() => {
											navigateToChat(result.chatId, {
												chatTitle: result.chatTitle
											});
										}}
									>
										<div class="flex items-center gap-1.5 flex-1 min-w-0">
											<SidebarModelLogo modelId={result.modelId} />
											<div class="search-result-title text-sm font-medium text-ellipsis line-clamp-1 flex-1 min-w-0">
												{@html result.chatTitleHtml}
											</div>
										</div>
										<div class="flex items-center gap-2 shrink-0 ml-2">
											<span
												class="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
											>
												{result.matchCount}
												{result.matchCount === 1 ? 'match' : 'matches'}
											</span>
											<span class="text-xs text-gray-400 dark:text-gray-500">
												{dayjs(result.updatedAt * 1000).calendar(null, {
													sameDay: '[Today]',
													nextDay: '[Tomorrow]',
													nextWeek: 'dddd',
													lastDay: '[Yesterday]',
													lastWeek: '[Last] dddd',
													sameElse: 'L'
												})}
											</span>
										</div>
									</button>

									<div class="flex flex-col gap-1">
										{#each result.matches as match, matchIdx}
											{@const matchKey = `${result.chatId}:${match.message_id}:${matchIdx}`}
											<button
												type="button"
												class="w-full text-left flex items-start gap-2 py-1.5 px-1 rounded-lg text-xs text-gray-600 dark:text-gray-400 border border-transparent transition-colors hover:bg-white/60 dark:hover:bg-black/10"
												class:search-result-selected={selectedKey === matchKey}
												class:search-result-previewed={selectedChatId === result.chatId && selectedMessageId === match.message_id}
												data-arrow-selected={selectedKey === matchKey ? 'true' : undefined}
												on:mouseenter={() => {
													if (lastInteraction === 'mouse') setSelectedByKey(matchKey);
												}}
												on:click={() => {
													if (selectedChatId === result.chatId && selectedMessageId === match.message_id) {
														navigateToMessage(result.chatId, match.message_id, { chatTitle: result.chatTitle });
														return;
													}
													setSelectedByKey(matchKey);
													void loadChatPreview(result.chatId, match.message_id);
												}}
												on:dblclick={() => {
													navigateToMessage(result.chatId, match.message_id, {
														chatTitle: result.chatTitle
													});
												}}
											>
												<span
													class="shrink-0 text-[10px] font-medium px-1 py-0.5 rounded {match.role ===
													'user'
														? 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400'
														: 'bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400'}"
												>
													{match.role === 'user' ? 'You' : 'AI'}
												</span>
												<span class="snippet-text line-clamp-2">
													{@html match.snippet}
												</span>
											</button>
										{/each}
									</div>
								</div>
							{/if}

							{#if idx < searchResults.length - 1}
								<hr class="border-gray-100 dark:border-gray-800 my-1" />
							{/if}
						{/each}
					{/if}

					{#if hasMoreMessages}
						<Loader
							on:visible={() => {
								if (!chatListLoading) {
									loadMoreMessages();
								}
							}}
						>
							<div
								class="w-full flex justify-center py-4 text-xs animate-pulse items-center gap-2"
							>
								<Spinner className=" size-4" />
								<div class=" ">{$i18n.t('Loading...')}</div>
							</div>
						</Loader>
					{/if}
				{/if}
			</div>

			<div
				id="chat-preview"
				class="search-preview-pane search-preview-surface hidden md:flex md:flex-1 w-full overflow-y-auto @container"
			>
				{#if messages === null}
					<div
						class="w-full h-full flex justify-center items-center text-gray-500 dark:text-gray-400 text-sm"
					>
						{$i18n.t('Select a conversation to preview')}
					</div>
				{:else}
					<div class="w-full h-full flex flex-col">
						<Messages
							className="h-full flex pt-0 w-full"
							chatId={`chat-preview-${selectedChat?.id ?? ''}`}
							user={$user}
							readOnly={true}
							hideUserMessageCopy={true}
							topPadding={true}
							messagesCount={previewMessagesCount}
							{selectedModels}
							bind:history
							bind:messages
							autoScroll={false}
							sendMessage={() => {}}
							continueResponse={() => {}}
							regenerateResponse={() => {}}
						/>
					</div>
				{/if}
			</div>
		</div>

		{#if hasActiveQuery && searchResults.length > 0}
			<div
				class="px-4 pt-1 pb-1 flex items-center justify-between text-[10px] text-gray-400 dark:text-gray-500"
			>
				<div>{searchSummaryText}</div>
				<div class="flex items-center gap-3">
					<span title="CMD+F: Find in current chat">&#8984;F Find in chat</span>
					<span title="Shift+CMD+F: Search conversations">&#8679;&#8984;F Search</span>
				</div>
			</div>
		{/if}
	</div>
</Modal>
