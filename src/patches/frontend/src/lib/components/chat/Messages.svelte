<script lang="ts">
	import { v4 as uuidv4 } from 'uuid';
	import {
		config,
		settings,
		user as _user,
		mobile,
		temporaryChatEnabled
	} from '$lib/stores';
	import { tick, getContext, onMount, createEventDispatcher } from 'svelte';
	const dispatch = createEventDispatcher();

	import { toast } from 'svelte-sonner';
	import { updateChatById } from '$lib/apis/chats';
	import { copyToClipboard, extractCurlyBraceWords } from '$lib/utils';
	import { refreshChatListPageOne } from '$lib/utils/chatListPagination';
	import { REVEAL_EXPAND_REQUEST_EVENT } from '$lib/utils/messageNavigation';

	import Message from './Messages/Message.svelte';
	import DebugRequestMarker from './DebugRequestMarker.svelte';
	import Loader from '../common/Loader.svelte';
	import Spinner from '../common/Spinner.svelte';

	import ChatPlaceholder from './ChatPlaceholder.svelte';
	// PORTICO-348: pending Ask User Question flows render inline in the transcript
	// instead of a window-wide blocking modal.
	import UserQuestionPromptCard from './Messages/UserQuestionPromptCard.svelte';
	import { pendingUserQuestionsByChatId } from '$lib/stores/pendingUserQuestions';
	import { isUserQuestionAnchorOnActiveBranch } from '$lib/utils/userQuestionAnswered';
	import { userQuestionAutoScrollKey } from '$lib/utils/userQuestionAutoScroll.js';

	const i18n = getContext('i18n');

	export let className = 'h-full flex pt-0';

	export let chatId = '';
	// Only this chat's pending question is ever rendered here.
	$: pendingUserQuestionFlow = chatId ? ($pendingUserQuestionsByChatId.get(chatId) ?? null) : null;
	export let user = $_user;

	export let prompt;
	export let history = {};
	export let selectedModels: string[] = [''];
	export let reasoningEffortByModel: Record<string, string> = {};
	export let atSelectedModel;
	export let richContentReady = true;
	let anchoredUserQuestionFlowId = '';
	let userQuestionAnchorMessageId = '';
	$: if (!pendingUserQuestionFlow) {
		anchoredUserQuestionFlowId = '';
		userQuestionAnchorMessageId = '';
	} else if (pendingUserQuestionFlow.flowId !== anchoredUserQuestionFlowId) {
		anchoredUserQuestionFlowId = pendingUserQuestionFlow.flowId;
		userQuestionAnchorMessageId = history?.currentId ?? '';
	} else if (!userQuestionAnchorMessageId && history?.currentId) {
		// A snapshot can arrive while chat history is still hydrating.
		userQuestionAnchorMessageId = history.currentId;
	}
	$: pendingUserQuestionIsOnActiveBranch = Boolean(
		pendingUserQuestionFlow &&
			isUserQuestionAnchorOnActiveBranch(history, userQuestionAnchorMessageId)
	);

	// An inline question blocks the run — a card below the fold reads as a
	// stall. Scroll THIS pane to the bottom when a flow appears on the active
	// branch, grows new pages, or switches questions (the next question can be
	// taller than the previous, clipping its controls). Typing/selecting within
	// a question changes no key input, so it cannot fight the user mid-answer.
	let userQuestionScrollKey = '';
	let userQuestionCurrentIndex = 0;
	$: {
		const nextKey = userQuestionAutoScrollKey(
			pendingUserQuestionIsOnActiveBranch ? pendingUserQuestionFlow : null,
			userQuestionCurrentIndex
		);
		if (nextKey !== userQuestionScrollKey) {
			userQuestionScrollKey = nextKey;
			if (nextKey) {
				void tick().then(() => scrollToBottom());
			}
		}
	}

	let messages = [];

	export let setInputText: Function = () => {};

	export let sendMessage: Function;
	export let continueResponse: Function;
	export let regenerateResponse: Function;
	export let mergeResponses: Function;
	export let stopResponse: Function = () => {};
	// PORTICO PATCH (fork-chat)
	export let forkChat: Function | null = null;

	export let chatActionHandler: Function;
	export let showMessage: Function = () => {};
	export let submitMessage: Function = () => {};
	export let addMessages: Function = () => {};

	export let readOnly = false;
	export let editCodeBlock = true;
	export let hideUserMessageCopy = false;

	export let topPadding = false;
	export let bottomPadding = false;
	export let autoScroll;
	export let debugMarkersAfterMessageId: Record<string, any[]> = {};
	export let debugMarkersAfterToolBlockByMessageId: Record<string, Record<number, any[]>> = {};
	export let debugBackgroundMarkers: any[] = [];
	export let openDebugRequestModal: (requestId: string) => void = () => {};

	export let onSelect = (e) => {};

	export let messagesCount: number | null = 20;
	let messagesLoading = false;
	const LOCAL_FIND_HISTORY_BATCH_SIZE = 20;
	const LOCAL_FIND_HISTORY_REQUEST_EVENT = 'portico-local-find-history-request';
	const LOCAL_FIND_HISTORY_RESPONSE_EVENT = 'portico-local-find-history-response';

	const normalizeFindTextValue = (value: unknown): string => {
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		return '';
	};

	const extractLocalFindMessageText = (message: Record<string, any> | null | undefined): string => {
		if (!message) return '';

		const mergedContent = normalizeFindTextValue(message?.merged?.content);
		if (mergedContent) {
			return mergedContent;
		}

		const content = message?.content;
		if (typeof content === 'string') return content;
		if (Array.isArray(content)) {
			return content
				.map((item) => {
					if (typeof item === 'string') return item;
					if (item && typeof item === 'object') {
						if (item.type && item.type !== 'text') return '';
						return normalizeFindTextValue(item.text) || normalizeFindTextValue(item.content) || '';
					}
					return '';
				})
				.join('');
		}

		if (content && typeof content === 'object') {
			const contentText =
				normalizeFindTextValue((content as Record<string, unknown>).text) ||
				normalizeFindTextValue((content as Record<string, unknown>).content) ||
				'';
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
									: normalizeFindTextValue(item?.text) || normalizeFindTextValue(item?.content) || ''
							)
							.join('');
					}
					return normalizeFindTextValue(block.content) || normalizeFindTextValue(block.text) || '';
				})
				.join('');
		}

		return '';
	};

	const messageMatchesLocalFind = (
		message: Record<string, any> | null | undefined,
		query: string,
		caseSensitive: boolean
	): boolean => {
		const normalizedQuery = typeof query === 'string' ? query : '';
		if (!normalizedQuery) {
			return false;
		}

		const haystack = extractLocalFindMessageText(message);
		if (!haystack) {
			return false;
		}

		return caseSensitive
			? haystack.includes(normalizedQuery)
			: haystack.toLowerCase().includes(normalizedQuery.toLowerCase());
	};

	const getConversationPathIds = (limit: number | null = messagesCount): string[] => {
		const pathIds: string[] = [];
		let message = history?.currentId ? history?.messages?.[history.currentId] : null;
		while (message && (limit !== null ? pathIds.length <= limit : true)) {
			pathIds.unshift(message.id);
			message = message.parentId !== null ? history?.messages?.[message.parentId] : null;
		}
		return pathIds;
	};

	const getLocalFindHistoryExpansionCount = (
		query: string,
		caseSensitive: boolean,
		direction: 'forward' | 'backward'
	): number => {
		const fullPathIds = getConversationPathIds(null);
		const visiblePathIds = getConversationPathIds(messagesCount);
		const hiddenCount = Math.max(0, fullPathIds.length - visiblePathIds.length);
		if (!query || hiddenCount <= 0) {
			return 0;
		}

		const hiddenIds = fullPathIds.slice(0, hiddenCount);
		if (direction === 'forward') {
			for (let start = 0; start < hiddenIds.length; start += LOCAL_FIND_HISTORY_BATCH_SIZE) {
				const end = Math.min(hiddenIds.length, start + LOCAL_FIND_HISTORY_BATCH_SIZE);
				if (
					hiddenIds
						.slice(start, end)
						.some((messageId) =>
							messageMatchesLocalFind(history?.messages?.[messageId], query, caseSensitive)
						)
				) {
					return hiddenIds.length - start;
				}
			}
			return 0;
		}

		for (let end = hiddenIds.length; end > 0; end -= LOCAL_FIND_HISTORY_BATCH_SIZE) {
			const start = Math.max(0, end - LOCAL_FIND_HISTORY_BATCH_SIZE);
			if (
				hiddenIds
					.slice(start, end)
					.some((messageId) =>
						messageMatchesLocalFind(history?.messages?.[messageId], query, caseSensitive)
					)
			) {
				return hiddenIds.length - start;
			}
		}

		return 0;
	};

	const respondToLocalFindHistoryRequest = (requestId: string, expanded: boolean) => {
		window.dispatchEvent(
			new CustomEvent(LOCAL_FIND_HISTORY_RESPONSE_EVENT, {
				detail: {
					requestId,
					expanded
				}
			})
		);
	};

	const handleLocalFindHistoryRequest = async (event: Event) => {
		const detail = (event as CustomEvent)?.detail ?? {};
		const requestId = typeof detail.requestId === 'string' ? detail.requestId : '';
		if (!requestId) {
			return;
		}

		if (!history?.currentId || !history?.messages || messagesLoading || messagesCount === null) {
			respondToLocalFindHistoryRequest(requestId, false);
			return;
		}

		const query = typeof detail.query === 'string' ? detail.query : '';
		const direction = detail.direction === 'forward' ? 'forward' : 'backward';
		const expansionCount = getLocalFindHistoryExpansionCount(
			query,
			Boolean(detail.caseSensitive),
			direction
		);

		if (expansionCount <= 0) {
			respondToLocalFindHistoryRequest(requestId, false);
			return;
		}

		const container = getScrollContainer();
		const previousScrollBottom = container
			? container.scrollHeight - container.scrollTop
			: null;

		messagesLoading = true;
		messagesCount += expansionCount;
		await tick();

		if (container && previousScrollBottom !== null) {
			container.scrollTop = Math.max(0, container.scrollHeight - previousScrollBottom);
		}

		messagesLoading = false;
		await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
		respondToLocalFindHistoryRequest(requestId, true);
	};

	// Instance-scoped: with multi-chat tiling several #messages-container
	// scrollers exist; resolve THIS component's ancestor, not the first id
	// match in the document (which is always the primary pane's).
	let messagesRootElement: HTMLElement | null = null;
	const getScrollContainer = (): HTMLElement | null =>
		(messagesRootElement?.closest('#chat-preview, #messages-container') as HTMLElement | null) ??
		document.getElementById('chat-preview') ??
		document.getElementById('messages-container');

	const loadMoreMessages = async () => {
		const element = getScrollContainer();
		// Preserve scroll-from-bottom so we can restore position after DOM expansion
		const previousScrollBottom = element
			? element.scrollHeight - element.scrollTop
			: null;

		messagesLoading = true;
		messagesCount += 20;

		await tick();

		if (element && previousScrollBottom !== null) {
			element.scrollTop = Math.max(0, element.scrollHeight - previousScrollBottom);
		}

		messagesLoading = false;
	};

	const handleRevealExpandRequest = (event: Event) => {
		const detail = (event as CustomEvent)?.detail ?? {};
		const targetId = typeof detail.messageId === 'string' ? detail.messageId : '';
		if (!targetId || messagesCount === null || messagesLoading) return;
		if (!history?.currentId || !history?.messages) return;
		if (document.getElementById(`message-${targetId}`)) return;

		const fullPath = getConversationPathIds(null);
		const targetIdx = fullPath.indexOf(targetId);
		if (targetIdx < 0) return;

		const needed = fullPath.length - targetIdx + 5;
		if (needed <= messagesCount) return;

		messagesLoading = true;
		messagesCount = needed;
		tick().then(() => {
			messagesLoading = false;
		});
	};

	onMount(() => {
		const requestListener = (event: Event) => {
			void handleLocalFindHistoryRequest(event);
		};

		window.addEventListener(LOCAL_FIND_HISTORY_REQUEST_EVENT, requestListener as EventListener);
		window.addEventListener(REVEAL_EXPAND_REQUEST_EVENT, handleRevealExpandRequest as EventListener);

		return () => {
			window.removeEventListener(LOCAL_FIND_HISTORY_REQUEST_EVENT, requestListener as EventListener);
			window.removeEventListener(REVEAL_EXPAND_REQUEST_EVENT, handleRevealExpandRequest as EventListener);
		};
	});

	$: if (history.currentId) {
		messages = getConversationPathIds(messagesCount)
			.map((messageId) => history?.messages?.[messageId])
			.filter(Boolean)
			.map((message) => ({ ...message }));
	} else {
		messages = [];
	}

	const scrollToBottom = () => {
		const element = getScrollContainer();
		if (element) element.scrollTop = element.scrollHeight;
	};

	const updateChat = async () => {
		if (!$temporaryChatEnabled) {
			history = history;
			await tick();
			await updateChatById(localStorage.token, chatId, {
				history: history,
				messages: messages
			});

			await refreshChatListPageOne(localStorage.token);
		}
	};

	const gotoMessage = async (message, idx) => {
		// Determine the correct sibling list (either parent's children or root messages)
		let siblings;
		if (message.parentId !== null) {
			siblings = history.messages[message.parentId].childrenIds;
		} else {
			siblings = Object.values(history.messages)
				.filter((msg) => msg.parentId === null)
				.map((msg) => msg.id);
		}

		// Clamp index to a valid range
		idx = Math.max(0, Math.min(idx, siblings.length - 1));

		let messageId = siblings[idx];

		// If we're navigating to a different message
		if (message.id !== messageId) {
			// Drill down to the deepest child of that branch
			let messageChildrenIds = history.messages[messageId].childrenIds;
			while (messageChildrenIds.length !== 0) {
				messageId = messageChildrenIds.at(-1);
				messageChildrenIds = history.messages[messageId].childrenIds;
			}

			history.currentId = messageId;
		}

		await tick();

		// Optional auto-scroll
		if ($settings?.scrollOnBranchChange ?? true) {
			const element = getScrollContainer();
			if (element) {
				autoScroll = element.scrollHeight - element.scrollTop <= element.clientHeight + 50;
			}

			setTimeout(() => {
				scrollToBottom();
			}, 100);
		}
	};

	const showPreviousMessage = async (message) => {
		if (message.parentId !== null) {
			let messageId =
				history.messages[message.parentId].childrenIds[
					Math.max(history.messages[message.parentId].childrenIds.indexOf(message.id) - 1, 0)
				];

			if (message.id !== messageId) {
				let messageChildrenIds = history.messages[messageId].childrenIds;

				while (messageChildrenIds.length !== 0) {
					messageId = messageChildrenIds.at(-1);
					messageChildrenIds = history.messages[messageId].childrenIds;
				}

				history.currentId = messageId;
			}
		} else {
			let childrenIds = Object.values(history.messages)
				.filter((message) => message.parentId === null)
				.map((message) => message.id);
			let messageId = childrenIds[Math.max(childrenIds.indexOf(message.id) - 1, 0)];

			if (message.id !== messageId) {
				let messageChildrenIds = history.messages[messageId].childrenIds;

				while (messageChildrenIds.length !== 0) {
					messageId = messageChildrenIds.at(-1);
					messageChildrenIds = history.messages[messageId].childrenIds;
				}

				history.currentId = messageId;
			}
		}

		await tick();

		if ($settings?.scrollOnBranchChange ?? true) {
			const element = getScrollContainer();
			if (element) {
				autoScroll = element.scrollHeight - element.scrollTop <= element.clientHeight + 50;
			}

			setTimeout(() => {
				scrollToBottom();
			}, 100);
		}
	};

	const showNextMessage = async (message) => {
		if (message.parentId !== null) {
			let messageId =
				history.messages[message.parentId].childrenIds[
					Math.min(
						history.messages[message.parentId].childrenIds.indexOf(message.id) + 1,
						history.messages[message.parentId].childrenIds.length - 1
					)
				];

			if (message.id !== messageId) {
				let messageChildrenIds = history.messages[messageId].childrenIds;

				while (messageChildrenIds.length !== 0) {
					messageId = messageChildrenIds.at(-1);
					messageChildrenIds = history.messages[messageId].childrenIds;
				}

				history.currentId = messageId;
			}
		} else {
			let childrenIds = Object.values(history.messages)
				.filter((message) => message.parentId === null)
				.map((message) => message.id);
			let messageId =
				childrenIds[Math.min(childrenIds.indexOf(message.id) + 1, childrenIds.length - 1)];

			if (message.id !== messageId) {
				let messageChildrenIds = history.messages[messageId].childrenIds;

				while (messageChildrenIds.length !== 0) {
					messageId = messageChildrenIds.at(-1);
					messageChildrenIds = history.messages[messageId].childrenIds;
				}

				history.currentId = messageId;
			}
		}

		await tick();

		if ($settings?.scrollOnBranchChange ?? true) {
			const element = getScrollContainer();
			if (element) {
				autoScroll = element.scrollHeight - element.scrollTop <= element.clientHeight + 50;
			}

			setTimeout(() => {
				scrollToBottom();
			}, 100);
		}
	};

	const rateMessage = async (messageId, rating) => {
		history.messages[messageId].annotation = {
			...history.messages[messageId].annotation,
			rating: rating
		};

		await updateChat();
	};

	const editMessage = async (messageId, { content, files }, submit = true) => {
		if ((selectedModels ?? []).filter((id) => id).length === 0) {
			toast.error($i18n.t('Model not selected'));
			return;
		}
		if (history.messages[messageId].role === 'user') {
			if (submit) {
				// New user message
				let userPrompt = content;
				let userMessageId = uuidv4();

				let userMessage = {
					id: userMessageId,
					parentId: history.messages[messageId].parentId,
					childrenIds: [],
					role: 'user',
					content: userPrompt,
					...(files && { files: files }),
					models: selectedModels,
					timestamp: Math.floor(Date.now() / 1000) // Unix epoch
				};

				let messageParentId = history.messages[messageId].parentId;

				if (messageParentId !== null) {
					history.messages[messageParentId].childrenIds = [
						...history.messages[messageParentId].childrenIds,
						userMessageId
					];
				}

				history.messages[userMessageId] = userMessage;
				history.currentId = userMessageId;

				await tick();
				await sendMessage(history, userMessageId);
			} else {
				// Edit user message
				history.messages[messageId].content = content;
				history.messages[messageId].files = files;
				await updateChat();
			}
		} else {
			if (submit) {
				// New response message
				const responseMessageId = uuidv4();
				const message = history.messages[messageId];
				const parentId = message.parentId;

				const responseMessage = {
					...message,
					id: responseMessageId,
					parentId: parentId,
					childrenIds: [],
					files: undefined,
					content: content,
					timestamp: Math.floor(Date.now() / 1000) // Unix epoch
				};

				history.messages[responseMessageId] = responseMessage;
				history.currentId = responseMessageId;

				// Append messageId to childrenIds of parent message
				if (parentId !== null) {
					history.messages[parentId].childrenIds = [
						...history.messages[parentId].childrenIds,
						responseMessageId
					];
				}

				await updateChat();
			} else {
				// Edit response message
				history.messages[messageId].originalContent = history.messages[messageId].content;
				history.messages[messageId].content = content;
				await updateChat();
			}
		}
	};

	const actionMessage = async (actionId, message, event = null) => {
		await chatActionHandler(chatId, actionId, message.model, message.id, event);
	};

	const saveMessage = async (messageId, message) => {
		history.messages[messageId] = message;
		await updateChat();
	};

	const deleteMessage = async (messageId) => {
		const messageToDelete = history.messages[messageId];
		const parentMessageId = messageToDelete.parentId;
		const childMessageIds = messageToDelete.childrenIds ?? [];

		// Collect all grandchildren
		const grandchildrenIds = childMessageIds.flatMap(
			(childId) => history.messages[childId]?.childrenIds ?? []
		);

		// Update parent's children
		if (parentMessageId && history.messages[parentMessageId]) {
			history.messages[parentMessageId].childrenIds = [
				...history.messages[parentMessageId].childrenIds.filter((id) => id !== messageId),
				...grandchildrenIds
			];
		}

		// Update grandchildren's parent
		grandchildrenIds.forEach((grandchildId) => {
			if (history.messages[grandchildId]) {
				history.messages[grandchildId].parentId = parentMessageId;
			}
		});

		// Delete the message and its children
		[messageId, ...childMessageIds].forEach((id) => {
			delete history.messages[id];
		});

		await tick();

		showMessage({ id: parentMessageId });

		// Update the chat
		await updateChat();
	};

	const triggerScroll = () => {
		if (autoScroll) {
			const element = getScrollContainer();
			if (!element) return;
			autoScroll = element.scrollHeight - element.scrollTop <= element.clientHeight + 50;
			setTimeout(() => {
				scrollToBottom();
			}, 100);
		}
	};
</script>

<div class={className} bind:this={messagesRootElement}>
	{#if Object.keys(history?.messages ?? {}).length == 0}
		<ChatPlaceholder modelIds={selectedModels} {atSelectedModel} {onSelect} />
	{:else}
		<div class="w-full">
			{#key chatId}
				<section class="w-full" aria-labelledby="chat-conversation">
					<h2 class="sr-only" id="chat-conversation">{$i18n.t('Chat Conversation')}</h2>
					{#if messages.at(0)?.parentId !== null}
						<Loader
							on:visible={(e) => {
								console.log('visible');
								if (!messagesLoading) {
									loadMoreMessages();
								}
							}}
						>
							<div class="w-full flex justify-center py-1 text-xs animate-pulse items-center gap-2">
								<Spinner className=" size-4" />
								<div class=" ">{$i18n.t('Loading...')}</div>
							</div>
						</Loader>
					{/if}
					<ul role="log" aria-live="polite" aria-relevant="additions" aria-atomic="false">
						{#each messages as message, messageIdx (message.id)}
							<Message
								{chatId}
								bind:history
								{selectedModels}
								{richContentReady}
								messageId={message.id}
								idx={messageIdx}
								{user}
								{setInputText}
								{gotoMessage}
								{showPreviousMessage}
								{showNextMessage}
								{updateChat}
								{editMessage}
								{deleteMessage}
								{rateMessage}
								{actionMessage}
								{saveMessage}
								{submitMessage}
								{regenerateResponse}
								{forkChat}
								{continueResponse}
								{mergeResponses}
								{stopResponse}
								{addMessages}
								{triggerScroll}
								{readOnly}
								{editCodeBlock}
								{hideUserMessageCopy}
								{topPadding}
								{debugMarkersAfterToolBlockByMessageId}
								{openDebugRequestModal}
							/>
							{#if debugMarkersAfterMessageId?.[message.id]?.length}
								<li class="px-5 max-w-4xl mx-auto w-full" role="presentation">
									{#each debugMarkersAfterMessageId[message.id] as request (request.request_id)}
										<DebugRequestMarker request={request} onInspect={openDebugRequestModal} />
									{/each}
								</li>
							{/if}
						{/each}
						{#if debugBackgroundMarkers?.length}
							<li class="px-5 max-w-4xl mx-auto w-full" role="presentation">
								{#each debugBackgroundMarkers as request (request.request_id)}
									<DebugRequestMarker request={request} onInspect={openDebugRequestModal} />
								{/each}
							</li>
						{/if}
					</ul>
				</section>
				{#if pendingUserQuestionFlow}
					<div
						class="px-5 max-w-4xl mx-auto w-full"
						class:hidden={!pendingUserQuestionIsOnActiveBranch}
						inert={!pendingUserQuestionIsOnActiveBranch}
					>
						<UserQuestionPromptCard
							flow={pendingUserQuestionFlow}
							{chatId}
							bind:currentIndex={userQuestionCurrentIndex}
							defaultModelId={selectedModels.find((id) => id) ?? ''}
							defaultReasoningEffort={reasoningEffortByModel?.['0'] ?? ''}
						/>
					</div>
				{/if}
				<div class="pb-18"></div>
				{#if bottomPadding}
					<div class="  pb-6"></div>
				{/if}
			{/key}
		</div>
	{/if}
</div>
