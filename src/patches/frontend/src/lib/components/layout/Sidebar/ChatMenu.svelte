<!--
  PORTICO PATCHED FILE

  Changes from original Open WebUI Sidebar/ChatMenu.svelte:
  1. Removed the "Share" menu item
-->
<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import { flyAndScale } from '$lib/utils/transitions';
	import { getContext, createEventDispatcher, tick } from 'svelte';

	import fileSaver from 'file-saver';
	const { saveAs } = fileSaver;

	const dispatch = createEventDispatcher();

	import Dropdown from '$lib/components/common/Dropdown.svelte';
	import GarbageBin from '$lib/components/icons/GarbageBin.svelte';
	import Pencil from '$lib/components/icons/Pencil.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import Tags from '$lib/components/chat/Tags.svelte';
	import ArchiveBox from '$lib/components/icons/ArchiveBox.svelte';
	import DocumentDuplicate from '$lib/components/icons/DocumentDuplicate.svelte';
	import Bookmark from '$lib/components/icons/Bookmark.svelte';
	import BookmarkSlash from '$lib/components/icons/BookmarkSlash.svelte';
	import {
		getChatById,
		getChatPinnedStatusById,
		toggleChatPinnedStatusById
	} from '$lib/apis/chats';
	import { chats, folders, settings, theme, user } from '$lib/stores';
	import { createMessagesList } from '$lib/utils';
	import { exportStylizedChatPdf } from '$lib/utils/pdf-export';
	import { toast } from 'svelte-sonner';
	import Download from '$lib/components/icons/Download.svelte';
	import Folder from '$lib/components/icons/Folder.svelte';
	import Messages from '$lib/components/chat/Messages.svelte';

	const i18n = getContext('i18n');

	export let shareHandler: Function;
	export let moveChatHandler: Function;

	export let cloneChatHandler: Function;
	export let archiveChatHandler: Function;
	export let renameHandler: Function;
	export let deleteHandler: Function;
	export let onClose: Function;

	export let chatId = '';

	let show = false;
	let pinned = false;

	let chat = null;
	let showFullMessages = false;

	const sidebarMenuPanelClass =
		'portico-menu-surface w-full max-w-[200px] portico-submenu-host';
	const sidebarMenuSubPanelClass =
		'portico-menu-submenu w-full';
	const sidebarMenuItemClass =
		'portico-menu-item';
	const sidebarMenuDividerClass = 'portico-menu-divider';

	const pinHandler = async () => {
		await toggleChatPinnedStatusById(localStorage.token, chatId);
		dispatch('change');
	};

	const checkPinned = async () => {
		pinned = await getChatPinnedStatusById(localStorage.token, chatId);
	};

	const getChatAsText = async (chat) => {
		const history = chat.chat.history;
		const messages = createMessagesList(history, history.currentId);
		const chatText = messages.reduce((a, message) => {
			return `${a}### ${message.role.toUpperCase()}\n${message.content}\n\n`;
		}, '');

		return chatText.trim();
	};

	const downloadTxt = async () => {
		const chat = await getChatById(localStorage.token, chatId);
		if (!chat) {
			return;
		}

		const chatText = await getChatAsText(chat);
		let blob = new Blob([chatText], {
			type: 'text/plain'
		});

		saveAs(blob, `chat-${chat.chat.title}.txt`);
	};

	const downloadPdf = async () => {
		chat = await getChatById(localStorage.token, chatId);
		if (!chat) {
			return;
		}

		if ($settings?.stylizedPdfExport ?? true) {
			showFullMessages = true;
			try {
				await tick();
				await exportStylizedChatPdf({ title: chat.chat.title });
			} catch (error) {
				console.error('Error generating PDF', error);
				toast.error($i18n.t('Failed to export chat as PDF'));
			} finally {
				showFullMessages = false;
			}
		} else {
			const { default: jsPDF } = await import('jspdf');
			const chatText = await getChatAsText(chat);

			const doc = new jsPDF();

			const left = 15;
			const top = 20;
			const right = 15;
			const bottom = 20;

			const pageHeight = doc.internal.pageSize.getHeight();
			const usableWidth = doc.internal.pageSize.getWidth() - left - right;

			const fontSize = 8;
			doc.setFontSize(fontSize);
			const lineHeight = fontSize * 1;

			const paragraphs = chatText.split('\n');

			let y = top;

			for (let paragraph of paragraphs) {
				const lines = doc.splitTextToSize(paragraph, usableWidth);

				for (let line of lines) {
					if (y + lineHeight > pageHeight - bottom) {
						doc.addPage();
						y = top;
					}
					doc.text(line, left, y);
					y += lineHeight * 0.5;
				}
				y += lineHeight * 0.1;
			}

			doc.save(`chat-${chat.chat.title}.pdf`);
		}
	};

	const downloadJSONExport = async () => {
		const chat = await getChatById(localStorage.token, chatId);

		if (chat) {
			let blob = new Blob([JSON.stringify([chat])], {
				type: 'application/json'
			});
			saveAs(blob, `chat-export-${Date.now()}.json`);
		}
	};

	$: if (show) {
		checkPinned();
	}
</script>

{#if chat && showFullMessages}
	<div class="hidden w-full h-full flex-col">
		<div id="full-messages-container">
			<Messages
				className="h-full flex pt-4 pb-8 w-full"
				chatId={`chat-preview-${chat?.id ?? ''}`}
				user={$user}
				readOnly={true}
				history={chat.chat.history}
				messages={chat.chat.messages}
				autoScroll={true}
				sendMessage={() => {}}
				continueResponse={() => {}}
				regenerateResponse={() => {}}
				messagesCount={null}
				editCodeBlock={false}
			/>
		</div>
	</div>
{/if}

<Dropdown
	bind:show
	on:change={(e) => {
		if (e.detail === false) {
			onClose();
		}
	}}
>
	<Tooltip content={$i18n.t('More')}>
		<slot />
	</Tooltip>

	<div slot="content">
		<DropdownMenu.Content
			class={sidebarMenuPanelClass}
			sideOffset={-2}
			side="bottom"
			align="start"
			collisionPadding={12}
			transition={flyAndScale}
		>
			<div class="portico-submenu-host-scroll" role="presentation">
			<DropdownMenu.Sub>
				<DropdownMenu.SubTrigger class={sidebarMenuItemClass}>
					<Download strokeWidth="1.5" />

					<div class="flex items-center">{$i18n.t('Download')}</div>
				</DropdownMenu.SubTrigger>
				<DropdownMenu.SubContent
					class={sidebarMenuSubPanelClass}
					transition={flyAndScale}
					sideOffset={8}
					collisionPadding={12}
				>
					{#if $user?.role === 'admin' || ($user.permissions?.chat?.export ?? true)}
						<DropdownMenu.Item class={sidebarMenuItemClass} on:click={downloadJSONExport}>
							<div class="flex items-center line-clamp-1">{$i18n.t('Export chat (.json)')}</div>
						</DropdownMenu.Item>
					{/if}

					<DropdownMenu.Item class={sidebarMenuItemClass} on:click={downloadTxt}>
						<div class="flex items-center line-clamp-1">{$i18n.t('Plain text (.txt)')}</div>
					</DropdownMenu.Item>

					<DropdownMenu.Item
						class={`${sidebarMenuItemClass} select-none w-full`}
						on:click={downloadPdf}
					>
						<div class="flex items-center line-clamp-1">{$i18n.t('PDF document (.pdf)')}</div>
					</DropdownMenu.Item>
				</DropdownMenu.SubContent>
			</DropdownMenu.Sub>

			<DropdownMenu.Item class={sidebarMenuItemClass} on:click={renameHandler}>
				<Pencil strokeWidth="1.5" />
				<div class="flex items-center">{$i18n.t('Rename')}</div>
			</DropdownMenu.Item>

			<hr class={sidebarMenuDividerClass} />

			<DropdownMenu.Item class={sidebarMenuItemClass} on:click={pinHandler}>
				{#if pinned}
					<BookmarkSlash strokeWidth="1.5" />
					<div class="flex items-center">{$i18n.t('Unpin')}</div>
				{:else}
					<Bookmark strokeWidth="1.5" />
					<div class="flex items-center">{$i18n.t('Pin')}</div>
				{/if}
			</DropdownMenu.Item>

			<DropdownMenu.Item class={sidebarMenuItemClass} on:click={cloneChatHandler}>
				<DocumentDuplicate strokeWidth="1.5" />
				<div class="flex items-center">{$i18n.t('Clone')}</div>
			</DropdownMenu.Item>

			{#if chatId && $folders.length > 0}
				<DropdownMenu.Sub>
					<DropdownMenu.SubTrigger
						class={`${sidebarMenuItemClass} select-none w-full`}
					>
						<Folder />

						<div class="flex items-center">{$i18n.t('Move')}</div>
					</DropdownMenu.SubTrigger>
					<DropdownMenu.SubContent
						class={`${sidebarMenuSubPanelClass} max-h-52 overflow-y-auto scrollbar-hidden`}
						transition={flyAndScale}
						sideOffset={8}
						collisionPadding={12}
					>
						{#each $folders.sort((a, b) => b.updated_at - a.updated_at) as folder}
							<DropdownMenu.Item
								class={sidebarMenuItemClass}
								on:click={() => {
									moveChatHandler(chatId, folder.id);
								}}
							>
								<Folder />

								<div class="flex items-center">{folder?.name ?? 'Folder'}</div>
							</DropdownMenu.Item>
						{/each}
					</DropdownMenu.SubContent>
				</DropdownMenu.Sub>
			{/if}

			<DropdownMenu.Item class={sidebarMenuItemClass} on:click={archiveChatHandler}>
				<ArchiveBox strokeWidth="1.5" />
				<div class="flex items-center">{$i18n.t('Archive')}</div>
			</DropdownMenu.Item>

			<DropdownMenu.Item class={sidebarMenuItemClass} on:click={deleteHandler}>
				<GarbageBin strokeWidth="1.5" />
				<div class="flex items-center">{$i18n.t('Delete')}</div>
			</DropdownMenu.Item>
			</div>
		</DropdownMenu.Content>
	</div>
</Dropdown>
