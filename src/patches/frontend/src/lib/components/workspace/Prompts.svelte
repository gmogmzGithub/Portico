<script lang="ts">
	import { toast } from 'svelte-sonner';
	import fileSaver from 'file-saver';
	const { saveAs } = fileSaver;

	import { goto } from '$app/navigation';
	import { onMount, getContext } from 'svelte';
	import { WEBUI_NAME, prompts as _prompts, showSidebar, user } from '$lib/stores';
	import { refreshWorkspaceCounts } from '$lib/stores/workspaceCounts';

	import {
		createNewPrompt,
		deletePromptByCommand,
		getPrompts,
		getPromptList
	} from '$lib/apis/prompts';
	import { slugify } from '$lib/utils';

	import PromptMenu from './Prompts/PromptMenu.svelte';
	import EllipsisHorizontal from '../icons/EllipsisHorizontal.svelte';
	import DeleteConfirmDialog from '$lib/components/common/ConfirmDialog.svelte';
	import Search from '../icons/Search.svelte';
	import Plus from '../icons/Plus.svelte';
	import Spinner from '../common/Spinner.svelte';
	import XMark from '../icons/XMark.svelte';
	import GarbageBin from '../icons/GarbageBin.svelte';
	import PromptIcon from './Prompts/PromptIcon.svelte';

	let shiftKey = false;

	const i18n = getContext('i18n');
	let promptsImportInputElement: HTMLInputElement;
	let loaded = false;

	let importFiles = null;
	let query = '';

	let prompts = [];

	let showDeleteConfirm = false;
	let deletePrompt = null;

	let filteredItems = [];

	$: if (prompts && query !== undefined) {
		setFilteredItems();
	}

	const setFilteredItems = () => {
		filteredItems = prompts.filter((p) => {
			if (query === '') return true;
			const lowerQuery = query.toLowerCase();
			return (
				(p.title || '').toLowerCase().includes(lowerQuery) ||
				(p.command || '').toLowerCase().includes(lowerQuery) ||
				(p.user?.name || '').toLowerCase().includes(lowerQuery) ||
				(p.user?.email || '').toLowerCase().includes(lowerQuery)
			);
		});
	};

	const shareHandler = async (prompt) => {
		toast.success($i18n.t('Redirecting you to Open WebUI Community'));

		const url = 'https://openwebui.com';

		const tab = await window.open(`${url}/prompts/create`, '_blank');
		window.addEventListener(
			'message',
			(event) => {
				if (event.origin !== url) return;
				if (event.data === 'loaded') {
					tab.postMessage(JSON.stringify(prompt), '*');
				}
			},
			false
		);
	};

	const cloneHandler = async (prompt) => {
		const clonedPrompt = { ...prompt };

		clonedPrompt.title = `${clonedPrompt.title} (Clone)`;
		const baseCommand = clonedPrompt.command.startsWith('/')
			? clonedPrompt.command.substring(1)
			: clonedPrompt.command;
		clonedPrompt.command = slugify(`${baseCommand} clone`);

		sessionStorage.prompt = JSON.stringify(clonedPrompt);
		goto('/workspace/prompts/create');
	};

	const exportHandler = async (prompt) => {
		let blob = new Blob([JSON.stringify([prompt])], {
			type: 'application/json'
		});
		saveAs(blob, `prompt-export-${Date.now()}.json`);
	};

	const deleteHandler = async (prompt) => {
		const command = prompt.command;

		const res = await deletePromptByCommand(localStorage.token, command).catch((err) => {
			toast.error(err);
			return null;
		});

		if (res) {
			toast.success($i18n.t(`Deleted {{name}}`, { name: command }));
		}

		await init();
		await refreshWorkspaceCounts();
	};

	const init = async () => {
		prompts = await getPromptList(localStorage.token);
		await _prompts.set(await getPrompts(localStorage.token));
	};

	const getPromptPreview = (prompt) => {
		const content = `${prompt?.content ?? ''}`.replace(/\s+/g, ' ').trim();
		return content || $i18n.t('No prompt content yet.');
	};

	onMount(async () => {
		await init();
		loaded = true;

		const onKeyDown = (event) => {
			if (event.key === 'Shift') {
				shiftKey = true;
			}
		};

		const onKeyUp = (event) => {
			if (event.key === 'Shift') {
				shiftKey = false;
			}
		};

		const onBlur = () => {
			shiftKey = false;
		};

		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		window.addEventListener('blur', onBlur);

		return () => {
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('blur', onBlur);
		};
	});
</script>

<svelte:head>
	<title>
		{$i18n.t('Prompts')} • {$WEBUI_NAME}
	</title>
</svelte:head>

{#if loaded}
	<DeleteConfirmDialog
		bind:show={showDeleteConfirm}
		title={$i18n.t('Delete prompt?')}
		on:confirm={() => {
			deleteHandler(deletePrompt);
		}}
	>
		<div class=" text-sm text-gray-500 truncate">
			{$i18n.t('This will delete')} <span class="  font-medium">{deletePrompt.command}</span>.
		</div>
	</DeleteConfirmDialog>

	<div
		class="prompts-management-page transition-transform duration-200 ease-in-out {$showSidebar
			? ''
			: 'md:-translate-x-[1.625rem]'}"
		data-portico-rail-compensated={$showSidebar ? 'false' : 'true'}
	>
		<input
			id="prompts-import-input"
			bind:this={promptsImportInputElement}
			bind:files={importFiles}
			type="file"
			accept=".json"
			hidden
			on:change={() => {
				const reader = new FileReader();
				reader.onload = async (event) => {
					const savedPrompts = JSON.parse(event.target.result);

					for (const prompt of savedPrompts) {
						await createNewPrompt(localStorage.token, {
							command: prompt.command.charAt(0) === '/' ? prompt.command.slice(1) : prompt.command,
							title: prompt.title,
							content: prompt.content
						}).catch((error) => {
							toast.error(`${error}`);
							return null;
						});
					}

					prompts = await getPromptList(localStorage.token);
					await _prompts.set(await getPrompts(localStorage.token));
					await refreshWorkspaceCounts();

					importFiles = [];
					promptsImportInputElement.value = '';
				};

				reader.readAsText(importFiles[0]);
			}}
		/>

		<section class="prompts-management-hero">
			<div class="prompts-management-hero-icon">
				<PromptIcon className="size-7" />
			</div>
			<div>
				<h1>{$i18n.t('Prompts')}</h1>
				<p>
					{$i18n.t(
						'Save reusable instructions, then bring them into any chat with a slash command.'
					)}
				</p>
			</div>

			<div class="prompts-management-count" aria-label={$i18n.t('Saved prompts')}>
				<span>{prompts.length}</span>
				{$i18n.t(prompts.length === 1 ? 'saved prompt' : 'saved prompts')}
			</div>

			{#if prompts.length}
				<div class="prompts-management-hero-actions">
					{#if $user?.role === 'admin' || $user?.permissions?.workspace?.prompts_import}
						<button
							class="prompts-button prompts-button-secondary"
							type="button"
							on:click={() => {
								promptsImportInputElement.click();
							}}
						>
							{$i18n.t('Import')}
						</button>
					{/if}

					{#if $user?.role === 'admin' || $user?.permissions?.workspace?.prompts_export}
						<button
							class="prompts-button prompts-button-secondary"
							type="button"
							on:click={async () => {
								let blob = new Blob([JSON.stringify(prompts)], {
									type: 'application/json'
								});
								saveAs(blob, `prompts-export-${Date.now()}.json`);
							}}
						>
							{$i18n.t('Export')}
						</button>
					{/if}
					<a
						class="prompts-button prompts-button-primary"
						href="/workspace/prompts/create"
					>
						<Plus className="size-3.5" strokeWidth="2.5" />
						<span>{$i18n.t('New prompt')}</span>
					</a>
				</div>
			{/if}
		</section>

		{#if prompts.length === 0}
			<section class="prompts-empty-state">
				<div class="prompts-empty-icon">
					<PromptIcon className="size-7" />
				</div>
				<h2>{$i18n.t('Build a library of your best instructions')}</h2>
				<p>
					{$i18n.t(
						'Create a prompt once, give it a memorable slash command, and reuse it whenever you need it.'
					)}
				</p>
				<div class="prompts-empty-actions">
					<a class="prompts-button prompts-button-primary" href="/workspace/prompts/create">
						<Plus className="size-3.5" strokeWidth="2.5" />
						<span>{$i18n.t('Create your first prompt')}</span>
					</a>
					{#if $user?.role === 'admin' || $user?.permissions?.workspace?.prompts_import}
						<button
							class="prompts-button prompts-button-secondary"
							type="button"
							on:click={() => {
								promptsImportInputElement.click();
							}}
						>
							{$i18n.t('Import')}
						</button>
					{/if}
				</div>
			</section>
		{:else}
			<section class="prompts-library-surface">
				<div class="prompts-library-toolbar">
					<label class="prompts-search-field">
						<span class="sr-only">{$i18n.t('Search prompts')}</span>
						<Search className="size-4" />
						<input bind:value={query} placeholder={$i18n.t('Search prompts')} />
						{#if query}
							<button
								class="prompts-search-clear"
								type="button"
								aria-label={$i18n.t('Clear search')}
								on:click={() => {
									query = '';
								}}
							>
								<XMark className="size-3.5" strokeWidth="2" />
							</button>
						{/if}
					</label>
					<div class="prompts-library-result-count">
						{filteredItems.length}
						{$i18n.t(filteredItems.length === 1 ? 'result' : 'results')}
					</div>
				</div>

				{#if filteredItems.length !== 0}
					<div class="prompts-card-grid">
						{#each filteredItems as prompt}
							<article class="prompts-card">
								<a
									class="prompts-card-main"
									href={`/workspace/prompts/edit?command=${encodeURIComponent(prompt.command)}`}
								>
									<div class="prompts-card-icon"><PromptIcon className="size-5" /></div>
									<div class="prompts-card-copy">
										<div class="prompts-card-heading">
											<h2>{prompt.title}</h2>
											<span class="prompts-command-pill">{prompt.command}</span>
										</div>
										<p>{getPromptPreview(prompt)}</p>
										<div class="prompts-card-footer">
											<span>{$i18n.t('Reusable prompt')}</span>
											<span aria-hidden="true">→</span>
										</div>
									</div>
								</a>

								<div class="prompts-card-actions">
									{#if shiftKey}
									<button
										class="prompts-icon-button"
										type="button"
										aria-label={$i18n.t('Delete {{name}}', { name: prompt.title })}
										on:click={() => {
											deleteHandler(prompt);
										}}
									>
										<GarbageBin />
									</button>
									{:else}
										<PromptMenu
											shareHandler={() => {
												shareHandler(prompt);
											}}
											cloneHandler={() => {
												cloneHandler(prompt);
											}}
											exportHandler={() => {
												exportHandler(prompt);
											}}
											deleteHandler={async () => {
												deletePrompt = prompt;
												showDeleteConfirm = true;
											}}
											onClose={() => {}}
										>
											<button
												class="prompts-icon-button"
												type="button"
												aria-label={$i18n.t('Actions for {{name}}', { name: prompt.title })}
											>
												<EllipsisHorizontal className="size-5" />
											</button>
										</PromptMenu>
									{/if}
								</div>
							</article>
						{/each}
					</div>
				{:else}
					<div class="prompts-no-results">
						<div class="prompts-no-results-icon"><Search className="size-5" /></div>
						<h2>{$i18n.t('No matching prompts')}</h2>
						<p>{$i18n.t('Try another title, slash command, or owner name.')}</p>
						<button
							class="prompts-button prompts-button-secondary"
							type="button"
							on:click={() => {
								query = '';
							}}
						>
							{$i18n.t('Clear search')}
						</button>
					</div>
				{/if}
			</section>
		{/if}
	</div>
{:else}
	<div
		class="prompts-management-loading transition-transform duration-200 ease-in-out {$showSidebar
			? ''
			: 'md:-translate-x-[1.625rem]'}"
		data-portico-rail-compensated={$showSidebar ? 'false' : 'true'}
	>
		<Spinner className="size-5" />
	</div>
{/if}
