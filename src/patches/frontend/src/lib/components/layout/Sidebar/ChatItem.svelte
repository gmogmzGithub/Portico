<!--
  PORTICO PATCHED FILE

  Changes from original Open WebUI Sidebar/ChatItem.svelte:
  1. Re-themed light-mode chat row hover and selected surfaces to match the blue-gray sidebar.
  2. Re-themed the ellipsis overlay strip and button hover so no white hover block appears in light mode.
  3. Round 4 / Issue 7b — render an amber attention dot next to the
     chat title when the gate has a pending chip for this chat.
     ChatItem subscribes to the ``chatAttention`` store directly so
     the dot works regardless of who instantiates the component
     (Sidebar.svelte, Folders.svelte, …) without prop drilling.
  4. Keep chat navigation payload-free: hovering a sidebar item must not
     fetch the full chat merely to enable drag-and-drop.
-->
<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { goto, invalidate, invalidateAll } from '$app/navigation';
	import { onMount, getContext, createEventDispatcher, tick, onDestroy } from 'svelte';
	const i18n = getContext('i18n');

	const dispatch = createEventDispatcher();

	import {
		cloneChatById,
		deleteChatById,
		getAllTags,
		getChatById,
		getChatListByTagName,
		getPinnedChatList,
		updateChatById,
		updateChatFolderIdById
	} from '$lib/apis/chats';
	import {
		chatId,
		chatTitle as _chatTitle,
		mobile,
		pinnedChats,
		showSidebar,
		tags,
		selectedFolder
	} from '$lib/stores';

	import ChatMenu from './ChatMenu.svelte';
	import DeleteConfirmDialog from '$lib/components/common/ConfirmDialog.svelte';
	import ShareChatModal from '$lib/components/chat/ShareChatModal.svelte';
	import GarbageBin from '$lib/components/icons/GarbageBin.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import ArchiveBox from '$lib/components/icons/ArchiveBox.svelte';
	import DragGhost from '$lib/components/common/DragGhost.svelte';
	import Check from '$lib/components/icons/Check.svelte';
	import XMark from '$lib/components/icons/XMark.svelte';
	import Document from '$lib/components/icons/Document.svelte';
	import Sparkles from '$lib/components/icons/Sparkles.svelte';
	import { generateTitle } from '$lib/apis';
	// PORTICO PATCH (Round 4 / Issue 7b): per-row attention dot.
	import TaskAttentionDot from './TaskAttentionDot.svelte';
	import ChatActivityBlocks from './ChatActivityBlocks.svelte';
	import SidebarModelLogo from './SidebarModelLogo.svelte';
	import { chatAttention } from '$lib/stores/chatAttention';
	import { chatRuntimeState } from '$lib/stores/chatRuntimeState';
	import { archiveChatSafely } from '$lib/apis/chatArchive.mjs';
	import { refreshChatListPageOne } from '$lib/utils/chatListPagination';

	export let className = '';

	export let id;
	export let title;
	export let modelId: string | null = null;

	export let selected = false;
	export let shiftKey = false;

	// PORTICO PATCH: merge persistent gate attention with the Electron
	// runtime snapshot so native prompts and pending chips share one
	// row-level attention treatment.
	$: runtimeState = $chatRuntimeState.get(id);
	$: isChatActive = runtimeState?.busy === true;
	$: persistedAttentionReason = $chatAttention?.get(id) ?? null;
	$: needsAttention = persistedAttentionReason !== null || runtimeState?.attentionRequired === true;
	$: hasUnreadUpdate =
		runtimeState?.unread === true && !needsAttention && id !== $chatId && !selected;
	$: hasStatusDot = needsAttention || hasUnreadUpdate;
	// The "…" actions menu is visible on hover AND whenever the row is selected,
	// being edited, or is the current chat — the status dot must shift left of the
	// ellipsis in all of those cases (not just hover) or it clips the menu.
	$: actionsVisible = mouseOver || selected || confirmEdit || id === $chatId;
	$: attentionReason =
		persistedAttentionReason ??
		(runtimeState?.attentionRequired === true ? 'This chat needs your attention' : null);
	$: shouldPulseForAttention =
		needsAttention && id !== $chatId && !selected && !confirmEdit && !mouseOver;
	$: statusTitlePaddingClass =
		hasStatusDot && shiftKey && mouseOver
			? 'pr-20'
			: hasStatusDot && actionsVisible
				? 'pr-14'
				: hasStatusDot
					? 'pr-6'
					: '';
	$: statusSlotRightClass =
		actionsVisible
			? shiftKey && mouseOver
				? 'right-[78px]'
				: className === 'pr-2'
					? 'right-[60px]'
					: 'right-[52px]'
			: 'right-[12px]';

	export let onDragEnd = () => {};

	let chat = null;
	let mouseOver = false;

	let showShareChatModal = false;
	let confirmEdit = false;

	let chatTitle = title;

	const editChatTitle = async (id, title) => {
		if (title === '') {
			toast.error($i18n.t('Title cannot be an empty string.'));
		} else {
			await updateChatById(localStorage.token, id, {
				title: title
			});

			if (id === $chatId) {
				_chatTitle.set(title);
			}

			await refreshChatListPageOne(localStorage.token);
			await pinnedChats.set(await getPinnedChatList(localStorage.token));

			dispatch('change');
		}
	};

	const cloneChatHandler = async (id) => {
		const res = await cloneChatById(
			localStorage.token,
			id,
			$i18n.t('Clone of {{TITLE}}', {
				TITLE: title
			})
		).catch((error) => {
			toast.error(`${error}`);
			return null;
		});

		if (res) {
			goto(`/c/${res.id}`);

			await refreshChatListPageOne(localStorage.token);
			await pinnedChats.set(await getPinnedChatList(localStorage.token));
		}
	};

	const deleteChatHandler = async (id) => {
		const res = await deleteChatById(localStorage.token, id).catch((error) => {
			toast.error(`${error}`);
			return null;
		});

		if (res) {
			tags.set(await getAllTags(localStorage.token));
			if ($chatId === id) {
				await goto('/');

				await chatId.set('');
				await tick();
			}

			dispatch('change');
		}
	};

	const archiveChatHandler = async (id) => {
		const archivedChat = await archiveChatSafely(localStorage.token, id).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
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
			tags.set(tagsResult.value);
		}

		dispatch('change');
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

				dispatch('change');

				toast.success($i18n.t('Chat moved successfully'));
			}
		} else {
			toast.error($i18n.t('Failed to move chat'));
		}
	};

	let itemElement;

	let generating = false;

	let ignoreBlur = false;
	let doubleClicked = false;

	let dragged = false;
	let x = 0;
	let y = 0;

	const dragImage = new Image();
	dragImage.src =
		'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

	const onDragStart = (event) => {
		event.stopPropagation();

		event.dataTransfer.setDragImage(dragImage, 0, 0);

		// Set the data to be transferred. The drop target can resolve a same-app
		// chat by ID; embedding the full chat made every hover download it first.
		event.dataTransfer.setData(
			'text/plain',
			JSON.stringify({
				type: 'chat',
				id: id
			})
		);

		dragged = true;
		itemElement.style.opacity = '0.5'; // Optional: Visual cue to show it's being dragged
	};

	const onDrag = (event) => {
		event.stopPropagation();

		x = event.clientX;
		y = event.clientY;
	};

	const onDragEndHandler = (event) => {
		event.stopPropagation();

		itemElement.style.opacity = '1'; // Reset visual cue after drag
		dragged = false;

		onDragEnd(event);
	};

	const onClickOutside = (event) => {
		if (!itemElement.contains(event.target)) {
			if (confirmEdit) {
				if (chatTitle !== title) {
					editChatTitle(id, chatTitle);
				}

				confirmEdit = false;
				chatTitle = '';
			}
		}
	};

	onMount(() => {
		if (itemElement) {
			document.addEventListener('click', onClickOutside, true);

			// Event listener for when dragging starts
			itemElement.addEventListener('dragstart', onDragStart);
			// Event listener for when dragging occurs (optional)
			itemElement.addEventListener('drag', onDrag);
			// Event listener for when dragging ends
			itemElement.addEventListener('dragend', onDragEndHandler);
		}
	});

	onDestroy(() => {
		if (itemElement) {
			document.removeEventListener('click', onClickOutside, true);

			itemElement.removeEventListener('dragstart', onDragStart);
			itemElement.removeEventListener('drag', onDrag);
			itemElement.removeEventListener('dragend', onDragEndHandler);
		}
	});

	let showDeleteConfirm = false;

	const chatTitleInputKeydownHandler = (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			setTimeout(() => {
				const input = document.getElementById(`chat-title-input-${id}`);
				if (input) input.blur();
			}, 0);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			confirmEdit = false;
			chatTitle = '';
		}
	};

	const renameHandler = async () => {
		chatTitle = title;
		confirmEdit = true;

		await tick();

		setTimeout(() => {
			const input = document.getElementById(`chat-title-input-${id}`);
			if (input) {
				input.focus();
				input.select();
			}
		}, 0);
	};

	const generateTitleHandler = async () => {
		generating = true;
		if (!chat) {
			chat = await getChatById(localStorage.token, id);
		}

		const messages = (chat.chat?.messages ?? []).map((message) => {
			return {
				role: message.role,
				content: message.content
			};
		});

		const model = chat.chat.models.at(0) ?? chat.models.at(0) ?? '';

		chatTitle = '';

		const generatedTitle = await generateTitle(localStorage.token, model, messages).catch(
			(error) => {
				toast.error(`${error}`);
				return null;
			}
		);

		if (generatedTitle) {
			if (generatedTitle !== title) {
				editChatTitle(id, generatedTitle);
			}

			confirmEdit = false;
		} else {
			chatTitle = title;
		}

		generating = false;
	};
</script>

<ShareChatModal bind:show={showShareChatModal} chatId={id} />

<DeleteConfirmDialog
	bind:show={showDeleteConfirm}
	title={$i18n.t('Delete chat?')}
	on:confirm={() => {
		deleteChatHandler(id);
	}}
>
	<div class=" text-sm text-gray-500 flex-1 line-clamp-3">
		{$i18n.t('This will delete')} <span class="  font-semibold">{title}</span>.
	</div>
</DeleteConfirmDialog>

{#if dragged && x && y}
	<DragGhost {x} {y}>
		<div class=" bg-black/80 backdrop-blur-2xl px-2 py-1 rounded-lg w-fit max-w-40">
			<div class="flex items-center gap-1">
				<Document className=" size-[18px]" strokeWidth="2" />
				<div class=" text-xs text-white line-clamp-1">
					{title}
				</div>
			</div>
		</div>
	</DragGhost>
{/if}

<div
	id="sidebar-chat-group"
	bind:this={itemElement}
	class="w-full {className} relative group overflow-hidden rounded-xl"
	draggable={!confirmEdit}
>
	{#if confirmEdit}
		<div
			id="sidebar-chat-item"
			class=" w-full flex justify-between rounded-xl px-[11px] py-[6px] {id === $chatId ||
			confirmEdit || selected
				? 'selected'
				: ''} whitespace-nowrap text-ellipsis relative {generating
				? 'cursor-not-allowed'
				: ''}"
		>
			<div class="flex flex-1 min-w-0 items-center gap-1.5 mr-10">
				<SidebarModelLogo {modelId} />
				<input
					id="chat-title-input-{id}"
					bind:value={chatTitle}
					class=" bg-transparent flex-1 min-w-0 outline-hidden"
					placeholder={generating ? $i18n.t('Generating...') : ''}
					disabled={generating}
					on:keydown={chatTitleInputKeydownHandler}
					on:blur={async (e) => {
						if (doubleClicked) {
							e.preventDefault();
							e.stopPropagation();

							await tick();
							setTimeout(() => {
								const input = document.getElementById(`chat-title-input-${id}`);
								if (input) input.focus();
							}, 0);

							doubleClicked = false;
							return;
						}
					}}
				/>
			</div>
		</div>
	{:else}
		<a
			id="sidebar-chat-item"
			class:sidebar-chat-attention-pulse={shouldPulseForAttention}
			class=" relative w-full flex justify-between rounded-xl px-[11px] py-[6px] {id === $chatId ||
			selected
				? 'selected'
				: ''} whitespace-nowrap text-ellipsis"
			href="/c/{id}"
			on:click={() => {
				dispatch('select');

				if ($selectedFolder) {
					selectedFolder.set(null);
				}

				if ($mobile) {
					showSidebar.set(false);
				}
			}}
			on:dblclick={async (e) => {
				e.preventDefault();
				e.stopPropagation();

				doubleClicked = true;
				renameHandler();
			}}
			on:mouseenter={(e) => {
				mouseOver = true;
			}}
			on:mouseleave={(e) => {
				mouseOver = false;
			}}
			on:focus={(e) => {}}
			draggable="false"
		>
			<div class=" flex self-center flex-1 w-full items-center gap-1.5 min-w-0 {statusTitlePaddingClass}">
				{#if isChatActive}
					<ChatActivityBlocks />
				{/if}
				<SidebarModelLogo {modelId} />
				<div
					dir="auto"
					class=" text-left self-center overflow-hidden flex-1 min-w-0 h-[20px] truncate"
				>
					{title}
				</div>
			</div>
			{#if hasStatusDot}
				<span
					class="sidebar-chat-status-slot absolute {statusSlotRightClass} inset-y-0 z-30 flex items-center transition-[right] duration-150 ease-out motion-reduce:transition-none"
				>
					{#if needsAttention}
						<TaskAttentionDot {needsAttention} reason={attentionReason} />
					{:else if hasUnreadUpdate}
						<span
							class="sidebar-chat-unread-dot size-2 rounded-full bg-blue-500 shadow-[0_0_0_2px_rgba(255,255,255,0.72)] dark:bg-blue-400 dark:shadow-[0_0_0_2px_rgba(15,23,42,0.8)]"
							role="img"
							aria-label={$i18n.t('New activity')}
							title={$i18n.t('New activity')}
						></span>
					{/if}
				</span>
			{/if}
		</a>
	{/if}

	<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div
			id="sidebar-chat-item-menu"
			class="{id === $chatId || confirmEdit || selected
			? 'selected'
			: 'invisible group-hover:visible'}
			absolute z-20 {className === 'pr-2'
			? 'right-[8px]'
			: 'right-0'} inset-y-0 flex items-center pr-1.5 pl-5 bg-transparent"
		on:mouseenter={(e) => {
			mouseOver = true;
		}}
		on:mouseleave={(e) => {
			mouseOver = false;
		}}
	>
		{#if confirmEdit}
			<div
				class="flex self-center items-center space-x-1.5 z-10 translate-y-[0.5px] -translate-x-[0.5px]"
			>
				<Tooltip content={$i18n.t('Generate')}>
					<button
						class=" self-center dark:hover:text-white transition disabled:cursor-not-allowed"
						id="generate-title-button"
						disabled={generating}
						on:click={() => {
							generateTitleHandler();
						}}
					>
						<Sparkles strokeWidth="2" />
					</button>
				</Tooltip>
			</div>
		{:else if shiftKey && mouseOver}
			<div class=" flex items-center self-center space-x-1.5">
				<Tooltip content={$i18n.t('Archive')} className="flex items-center">
					<button
						class=" self-center dark:hover:text-white transition"
						on:click={() => {
							archiveChatHandler(id);
						}}
						type="button"
					>
						<ArchiveBox className="size-4  translate-y-[0.5px]" strokeWidth="2" />
					</button>
				</Tooltip>

				<Tooltip content={$i18n.t('Delete')}>
					<button
						class=" self-center dark:hover:text-white transition"
						on:click={() => {
							deleteChatHandler(id);
						}}
						type="button"
					>
						<GarbageBin strokeWidth="2" />
					</button>
				</Tooltip>
			</div>
		{:else}
			<div class="flex self-center z-10 items-end">
				<ChatMenu
					chatId={id}
					cloneChatHandler={() => {
						cloneChatHandler(id);
					}}
					shareHandler={() => {
						showShareChatModal = true;
					}}
					{moveChatHandler}
					archiveChatHandler={() => {
						archiveChatHandler(id);
					}}
					{renameHandler}
					deleteHandler={() => {
						showDeleteConfirm = true;
					}}
					onClose={() => {
						dispatch('unselect');
					}}
					on:change={async () => {
						dispatch('change');
					}}
					on:tag={(e) => {
						dispatch('tag', e.detail);
					}}
				>
					<button
						aria-label="Chat Menu"
						class="sidebar-chat-action self-center rounded-lg p-1 m-0 text-gray-700 hover:text-slate-900 dark:text-gray-300 dark:hover:text-white transition"
						on:click={() => {
							dispatch('select');
						}}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 16 16"
							fill="currentColor"
							class="w-4 h-4"
						>
							<path
								d="M2 8a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0ZM6.5 8a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0ZM12.5 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"
							/>
						</svg>
					</button>
				</ChatMenu>

				{#if id === $chatId}
					<!-- Shortcut support using "delete-chat-button" id -->
					<button
						id="delete-chat-button"
						class="hidden"
						on:click={() => {
							showDeleteConfirm = true;
						}}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 16 16"
							fill="currentColor"
							class="w-4 h-4"
						>
							<path
								d="M2 8a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0ZM6.5 8a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0ZM12.5 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"
							/>
						</svg>
					</button>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.sidebar-chat-attention-pulse {
		animation: sidebar-chat-attention-pulse 2.4s ease-in-out infinite;
	}

	@keyframes sidebar-chat-attention-pulse {
		0%,
		100% {
			background-color: rgba(249, 115, 22, 0.025);
		}
		50% {
			background-color: rgba(249, 115, 22, 0.105);
		}
	}

	:global(.dark) .sidebar-chat-attention-pulse {
		animation-name: sidebar-chat-attention-pulse-dark;
	}

	@keyframes sidebar-chat-attention-pulse-dark {
		0%,
		100% {
			background-color: rgba(249, 115, 22, 0.018);
		}
		50% {
			background-color: rgba(249, 115, 22, 0.09);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.sidebar-chat-attention-pulse {
			animation: none;
			background-color: rgba(249, 115, 22, 0.07);
		}

		:global(.dark) .sidebar-chat-attention-pulse {
			background-color: rgba(249, 115, 22, 0.055);
		}
	}
</style>
