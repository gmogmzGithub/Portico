<script lang="ts">
	import { toast } from 'svelte-sonner';

	import { tick, getContext, onMount, createEventDispatcher } from 'svelte';
	const dispatch = createEventDispatcher();
	const i18n = getContext('i18n');

	import { settings } from '$lib/stores';
	import { copyToClipboard } from '$lib/utils';

	import MultiResponseMessages from './MultiResponseMessages.svelte';
	import ResponseMessage from './ResponseMessage.svelte';
	import UserMessage from './UserMessage.svelte';

	export let chatId;
	export let selectedModels = [];
	export let richContentReady = true;
	export let idx = 0;

	export let history;
	export let messageId;

	export let user;

	export let setInputText: Function = () => {};
	export let gotoMessage;
	export let showPreviousMessage;
	export let showNextMessage;
	export let updateChat;

	export let editMessage;
	export let saveMessage;
	export let deleteMessage;
	export let rateMessage;
	export let actionMessage;
	export let submitMessage;

	export let regenerateResponse;
	export let continueResponse;
	export let mergeResponses;
	export let stopResponse: Function = () => {};
	// PORTICO PATCH (fork-chat)
	export let forkChat = null;

	export let addMessages;
	export let triggerScroll;
	export let readOnly = false;
	export let editCodeBlock = true;
	export let hideUserMessageCopy = false;
	export let topPadding = false;
	export let debugMarkersAfterToolBlockByMessageId: Record<string, Record<number, any[]>> = {};
	export let openDebugRequestModal: (requestId: string) => void = () => {};
</script>

<div
	role="listitem"
	class="flex flex-col justify-between px-5 mb-3 w-full {idx === 0 ? 'mt-7' : ''} {($settings?.widescreenMode ?? null)
		? 'max-w-full'
		: 'max-w-4xl'} mx-auto rounded-lg group"
>
	{#if history.messages[messageId]}
		{#if history.messages[messageId].role === 'user'}
			<UserMessage
				{user}
				{chatId}
				{history}
				{messageId}
				isFirstMessage={idx === 0}
				siblings={history.messages[messageId].parentId !== null
					? (history.messages[history.messages[messageId].parentId]?.childrenIds ?? [])
					: (Object.values(history.messages)
							.filter((message) => message.parentId === null)
							.map((message) => message.id) ?? [])}
				{gotoMessage}
				{showPreviousMessage}
				{showNextMessage}
				{editMessage}
				{deleteMessage}
				{readOnly}
				{editCodeBlock}
				hideCopyAction={hideUserMessageCopy}
				{topPadding}
			/>
		{:else if (history.messages[history.messages[messageId].parentId]?.models?.length ?? 1) === 1}
			<ResponseMessage
				{chatId}
				{history}
				{messageId}
				{selectedModels}
				{richContentReady}
				isLastMessage={messageId === history.currentId}
				siblings={history.messages[history.messages[messageId].parentId]?.childrenIds ?? []}
				{setInputText}
				{gotoMessage}
				{showPreviousMessage}
				{showNextMessage}
				{updateChat}
				{editMessage}
				{saveMessage}
				{rateMessage}
				{actionMessage}
				{submitMessage}
				{deleteMessage}
				{continueResponse}
				{stopResponse}
				{regenerateResponse}
				{forkChat}
				{addMessages}
				{readOnly}
				{editCodeBlock}
				{topPadding}
				debugMarkersAfterToolBlockIndex={debugMarkersAfterToolBlockByMessageId?.[messageId] ?? {}}
				{openDebugRequestModal}
			/>
		{:else}
			{#key messageId}
				<MultiResponseMessages
					bind:history
					{chatId}
					{messageId}
					{selectedModels}
					{richContentReady}
					isLastMessage={messageId === history?.currentId}
					{setInputText}
					{updateChat}
					{editMessage}
					{saveMessage}
					{rateMessage}
					{actionMessage}
					{submitMessage}
					{deleteMessage}
					{continueResponse}
					{regenerateResponse}
					{forkChat}
					{mergeResponses}
					{stopResponse}
					{triggerScroll}
					{addMessages}
					{readOnly}
					{editCodeBlock}
					{topPadding}
					{debugMarkersAfterToolBlockByMessageId}
					{openDebugRequestModal}
				/>
			{/key}
		{/if}
	{/if}
</div>
