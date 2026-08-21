<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { DropdownMenu } from 'bits-ui';
	import { getContext, onMount, tick } from 'svelte';

	import fileSaver from 'file-saver';
	const { saveAs } = fileSaver;

	import { copyToClipboard, createMessagesList } from '$lib/utils';
	import { exportStylizedChatPdf } from '$lib/utils/pdf-export';

	import {
		showOverview,
		showControls,
		showArtifacts,
		mobile,
		temporaryChatEnabled,
		theme,
		user,
		settings,
		folders,
		showEmbeds,
		artifactContents
	} from '$lib/stores';
	import { flyAndScale } from '$lib/utils/transitions';
	import { getChatById } from '$lib/apis/chats';

	import Dropdown from '$lib/components/common/Dropdown.svelte';
	import Tags from '$lib/components/chat/Tags.svelte';
	import Map from '$lib/components/icons/Map.svelte';
	import Clipboard from '$lib/components/icons/Clipboard.svelte';
	import Cube from '$lib/components/icons/Cube.svelte';
	import Folder from '$lib/components/icons/Folder.svelte';
	import ArchiveBox from '$lib/components/icons/ArchiveBox.svelte';
	import Messages from '$lib/components/chat/Messages.svelte';
	import Download from '$lib/components/icons/Download.svelte';
	import ArrowTopRightOnSquare from '$lib/components/icons/ArrowTopRightOnSquare.svelte';

	const i18n = getContext('i18n');

	export let moveChatHandler: Function;

	export let archiveChatHandler: Function;

	// export let tagHandler: Function;

	export let chat;
	export let onClose: Function = () => {};

	let showFullMessages = false;
	let canOpenWorkspace = false;

	type WorkspaceHostApi = {
		openChatWorkspace?: (chatId: string) => Promise<{
			success?: boolean;
			error?: string;
		}>;
	};

	const getWorkspaceHostApi = (): WorkspaceHostApi | undefined => {
		if (typeof window === 'undefined') {
			return undefined;
		}

		return (window as any)?.webviewHost as WorkspaceHostApi | undefined;
	};

	onMount(() => {
		canOpenWorkspace = typeof getWorkspaceHostApi()?.openChatWorkspace === 'function';
	});

	const getChatAsText = async () => {
		const history = chat.chat.history;
		const messages = createMessagesList(history, history.currentId);
		const chatText = messages.reduce((a, message, i, arr) => {
			return `${a}### ${message.role.toUpperCase()}\n${message.content}\n\n`;
		}, '');

		return chatText.trim();
	};

	const copyChatId = async () => {
		if (!chat?.id) {
			return;
		}

		const res = await copyToClipboard(chat.id).catch((e) => {
			console.error(e);
			return false;
		});

		if (res) {
			toast.success($i18n.t('Copied chat ID to clipboard'));
		}
	};

	const openWorkspace = async () => {
		if (!chat?.id) {
			return;
		}

		const hostApi = getWorkspaceHostApi();
		if (typeof hostApi?.openChatWorkspace !== 'function') {
			toast.error($i18n.t('Failed to open workspace'));
			return;
		}

		const result = await hostApi.openChatWorkspace(chat.id).catch((error) => {
			console.error(error);
			return {
				success: false,
				error: error?.message ?? 'Failed to open workspace'
			};
		});

		if (!result?.success) {
			toast.error(result?.error || $i18n.t('Failed to open workspace'));
		}
	};

	const downloadTxt = async () => {
		const chatText = await getChatAsText();

		let blob = new Blob([chatText], {
			type: 'text/plain'
		});

		saveAs(blob, `chat-${chat.chat.title}.txt`);
	};

	const downloadPdf = async () => {
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

			const chatText = await getChatAsText();

			const doc = new jsPDF();

			const left = 15;
			const top = 20;
			const right = 15;
			const bottom = 20;

			const pageWidth = doc.internal.pageSize.getWidth();
			const pageHeight = doc.internal.pageSize.getHeight();
			const usableWidth = pageWidth - left - right;
			const usableHeight = pageHeight - top - bottom;

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
		if (chat.id) {
			let chatObj = null;

			if ((chat?.id ?? '').startsWith('local') || $temporaryChatEnabled) {
				chatObj = chat;
			} else {
				chatObj = await getChatById(localStorage.token, chat.id);
			}

			let blob = new Blob([JSON.stringify([chatObj])], {
				type: 'application/json'
			});
			saveAs(blob, `chat-export-${Date.now()}.json`);
		}
	};
</script>

{#if showFullMessages}
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
	on:change={(e) => {
		if (e.detail === false) {
			onClose();
		}
	}}
>
	<slot />

	<div slot="content">
		<DropdownMenu.Content
			class="portico-menu-surface portico-submenu-host w-full max-w-[200px] rounded-2xl px-1 py-1  border border-gray-100  dark:border-gray-800 z-50 bg-white dark:bg-gray-850 dark:text-white shadow-lg transition"
			sideOffset={8}
			side="bottom"
			align="end"
			transition={flyAndScale}
		>
			<div class="portico-submenu-host-scroll" role="presentation">
			<DropdownMenu.Item
				class="flex gap-2 items-center px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl select-none w-full"
				id="chat-overview-button"
				on:click={async () => {
					await showControls.set(true);
					await showOverview.set(true);
					await showArtifacts.set(false);
					await showEmbeds.set(false);
				}}
			>
				<Map className=" size-4" strokeWidth="1.5" />
				<div class="flex items-center">{$i18n.t('Overview')}</div>
			</DropdownMenu.Item>

			{#if chat?.id}
				<DropdownMenu.Item
					class="flex gap-2 items-center px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl select-none w-full"
					id="chat-copy-id-button"
					on:click={copyChatId}
				>
					<Clipboard className=" size-4" strokeWidth="1.5" />
					<div class="flex items-center">{$i18n.t('Copy Chat ID')}</div>
				</DropdownMenu.Item>
			{/if}

			{#if chat?.id && canOpenWorkspace}
				<DropdownMenu.Item
					class="flex gap-2 items-center px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl select-none w-full"
					id="chat-open-workspace-button"
					on:click={openWorkspace}
				>
					<ArrowTopRightOnSquare className=" size-4" strokeWidth="1.5" />
					<div class="flex items-center">{$i18n.t('Open Workspace')}</div>
				</DropdownMenu.Item>
			{/if}

			{#if ($artifactContents ?? []).length > 0}
				<DropdownMenu.Item
					class="flex gap-2 items-center px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl select-none w-full"
					id="chat-artifacts-button"
					on:click={async () => {
						await showControls.set(true);
						await showArtifacts.set(true);
						await showOverview.set(false);
						await showEmbeds.set(false);
					}}
				>
					<Cube className=" size-4" strokeWidth="1.5" />
					<div class="flex items-center">{$i18n.t('Artifacts')}</div>
				</DropdownMenu.Item>
			{/if}

			<hr class="border-gray-50/30 dark:border-gray-800/30 my-1" />

			<DropdownMenu.Sub>
				<DropdownMenu.SubTrigger
					class="flex gap-2 items-center px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl select-none w-full"
				>
					<Download strokeWidth="1.5" />

					<div class="flex items-center">{$i18n.t('Download')}</div>
				</DropdownMenu.SubTrigger>
				<DropdownMenu.SubContent
					class="w-full rounded-2xl p-1 z-50 bg-white dark:bg-gray-850 dark:text-white border border-gray-100  dark:border-gray-800 shadow-lg max-h-52 overflow-y-auto scrollbar-hidden"
					transition={flyAndScale}
					sideOffset={8}
				>
					{#if $user?.role === 'admin' || ($user.permissions?.chat?.export ?? true)}
						<DropdownMenu.Item
							class="flex gap-2 items-center px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl select-none w-full"
							on:click={() => {
								downloadJSONExport();
							}}
						>
							<div class="flex items-center line-clamp-1">{$i18n.t('Export chat (.json)')}</div>
						</DropdownMenu.Item>
					{/if}
					<DropdownMenu.Item
						class="flex gap-2 items-center px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl select-none w-full"
						on:click={() => {
							downloadTxt();
						}}
					>
						<div class="flex items-center line-clamp-1">{$i18n.t('Plain text (.txt)')}</div>
					</DropdownMenu.Item>

					<DropdownMenu.Item
						class="flex gap-2 items-center px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl select-none w-full"
						on:click={() => {
							downloadPdf();
						}}
					>
						<div class="flex items-center line-clamp-1">{$i18n.t('PDF document (.pdf)')}</div>
					</DropdownMenu.Item>
				</DropdownMenu.SubContent>
			</DropdownMenu.Sub>

			<DropdownMenu.Item
				class="flex gap-2 items-center px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl select-none w-full"
				id="chat-copy-button"
				on:click={async () => {
					const res = await copyToClipboard(await getChatAsText()).catch((e) => {
						console.error(e);
					});

					if (res) {
						toast.success($i18n.t('Copied to clipboard'));
					}
				}}
			>
				<Clipboard className=" size-4" strokeWidth="1.5" />
				<div class="flex items-center">{$i18n.t('Copy')}</div>
			</DropdownMenu.Item>

			{#if !$temporaryChatEnabled && chat?.id}
				<hr class="border-gray-50/30 dark:border-gray-800/30 my-1" />

				{#if $folders.length > 0}
					<DropdownMenu.Sub>
						<DropdownMenu.SubTrigger
							class="flex gap-2 items-center px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl select-none w-full"
						>
							<Folder strokeWidth="1.5" />

							<div class="flex items-center">{$i18n.t('Move')}</div>
						</DropdownMenu.SubTrigger>
						<DropdownMenu.SubContent
							class="w-full rounded-2xl p-1 z-50 bg-white dark:bg-gray-850 dark:text-white border border-gray-100  dark:border-gray-800 shadow-lg max-h-52 overflow-y-auto scrollbar-hidden"
							transition={flyAndScale}
							sideOffset={8}
						>
							{#each $folders.sort((a, b) => b.updated_at - a.updated_at) as folder}
								{#if folder?.id}
									<DropdownMenu.Item
										class="flex gap-2 items-center px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl"
										on:click={() => {
											moveChatHandler(chat.id, folder.id);
										}}
									>
										<Folder strokeWidth="1.5" />

										<div class="flex items-center">{folder.name ?? 'Folder'}</div>
									</DropdownMenu.Item>
								{/if}
							{/each}
						</DropdownMenu.SubContent>
					</DropdownMenu.Sub>
				{/if}

				<DropdownMenu.Item
					class="flex gap-2 items-center px-3 py-1.5 text-sm  cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl"
					on:click={() => {
						archiveChatHandler();
					}}
				>
					<ArchiveBox className="size-4" strokeWidth="1.5" />
					<div class="flex items-center">{$i18n.t('Archive')}</div>
				</DropdownMenu.Item>

				<hr class="border-gray-50/30 dark:border-gray-800/30 my-1" />

				<div class="flex p-1">
					<Tags chatId={chat.id} />
				</div>
			{/if}
			</div>
		</DropdownMenu.Content>
	</div>
</Dropdown>
