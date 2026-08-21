<script lang="ts">
	import { toast } from 'svelte-sonner';

	import { onMount, getContext, tick } from 'svelte';
	import { models, tools, functions } from '$lib/stores';
	import { WEBUI_BASE_URL } from '$lib/constants';

	import { getTools } from '$lib/apis/tools';
	import { getFunctions } from '$lib/apis/functions';

	import Tags from '$lib/components/common/Tags.svelte';
	import ToolsSelector from '$lib/components/workspace/Models/ToolsSelector.svelte';
	import ActionsSelector from '$lib/components/workspace/Models/ActionsSelector.svelte';
	import Textarea from '$lib/components/common/Textarea.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import {
		getAvailableBaseModels,
		resolveAvailableBaseModelId
	} from '$lib/utils/modelSelection';

	const i18n = getContext('i18n');

	export let onSubmit: Function;
	export let onBack: null | Function = null;

	export let model = null;
	export let edit = false;

	export let preset = true;

	let loading = false;

	let filesInputElement;
	let inputFiles;

	let loaded = false;

	let id = '';
	let name = '';

	let enableDescription = true;

	$: if (!edit) {
		if (name) {
			id = name
				.replace(/\s+/g, '-')
				.replace(/[^a-zA-Z0-9-]/g, '')
				.toLowerCase();
		}
	}

	let system = '';
	let info = {
		id: '',
		base_model_id: null,
		name: '',
		meta: {
			profile_image_url: `${WEBUI_BASE_URL}/static/favicon.png`,
			description: '',
			suggestion_prompts: null,
			tags: []
		},
		params: {
			system: ''
		}
	};

	let params = {
		system: ''
	};

	let knowledge = [];
	let toolIds = [];

	let filterIds = [];
	let defaultFilterIds = [];

	let capabilities = {
		vision: true,
		file_upload: true,
		web_search: true,
		image_generation: true,
		code_interpreter: true,
		citations: true,
		status_updates: true,
		usage: undefined
	};
	let defaultFeatureIds = [];

	let actionIds = [];
	let accessControl = {};

	$: availableBaseModels = getAvailableBaseModels($models ?? [], {
		currentModelId: model?.id ?? null
	});

	$: if (preset) {
		info.base_model_id = resolveAvailableBaseModelId(info.base_model_id, $models ?? [], {
			currentModelId: model?.id ?? null
		});
	}

	$: primaryActionLabel = edit ? $i18n.t('Save Changes') : $i18n.t('Create Agent');

	const submitHandler = async () => {
		loading = true;

		info.id = id;
		info.name = name;

		if (id === '') {
			toast.error($i18n.t('Agent ID is required.'));
			loading = false;
			return;
		}

		if (name === '') {
			toast.error($i18n.t('Agent Name is required.'));
			loading = false;
			return;
		}

		if (preset && !info.base_model_id) {
			toast.error($i18n.t('An enabled base model is required.'));
			loading = false;
			return;
		}

		if (knowledge.some((item) => item.status === 'uploading')) {
			toast.error($i18n.t('Please wait until all files are uploaded.'));
			loading = false;
			return;
		}

		info.params = { ...info.params, ...params };

		info.access_control = accessControl;
		info.meta.capabilities = capabilities;

		if (enableDescription) {
			info.meta.description = info.meta.description.trim() === '' ? null : info.meta.description;
		} else {
			info.meta.description = null;
		}

		if (knowledge.length > 0) {
			info.meta.knowledge = knowledge;
		} else if (info.meta.knowledge) {
			delete info.meta.knowledge;
		}

		if (toolIds.length > 0) {
			info.meta.toolIds = toolIds;
		} else if (info.meta.toolIds) {
			delete info.meta.toolIds;
		}

		if (filterIds.length > 0) {
			info.meta.filterIds = filterIds;
		} else if (info.meta.filterIds) {
			delete info.meta.filterIds;
		}

		if (defaultFilterIds.length > 0) {
			info.meta.defaultFilterIds = defaultFilterIds;
		} else if (info.meta.defaultFilterIds) {
			delete info.meta.defaultFilterIds;
		}

		if (actionIds.length > 0) {
			info.meta.actionIds = actionIds;
		} else if (info.meta.actionIds) {
			delete info.meta.actionIds;
		}

		if (defaultFeatureIds.length > 0) {
			info.meta.defaultFeatureIds = defaultFeatureIds;
		} else if (info.meta.defaultFeatureIds) {
			delete info.meta.defaultFeatureIds;
		}

		info.params.system = system.trim() === '' ? null : system;
		info.params.stop = params.stop ? params.stop.split(',').filter((s) => s.trim()) : null;
		Object.keys(info.params).forEach((key) => {
			if (info.params[key] === '' || info.params[key] === null) {
				delete info.params[key];
			}
		});

		await onSubmit(info);

		loading = false;
	};

	onMount(async () => {
		await tools.set(await getTools(localStorage.token));
		await functions.set(await getFunctions(localStorage.token));

		const workspaceContainer = document.getElementById('workspace-container');
		if (workspaceContainer) {
			workspaceContainer.scrollTop = 0;
		}

		if (model) {
			name = model.name;
			await tick();

			id = model.id;

			enableDescription = model?.meta?.description !== null;

			if (model.base_model_id) {
				const baseModel = $models
					.filter((m) => !m?.preset && !(m?.arena ?? false))
					.find((m) => [model.base_model_id, `${model.base_model_id}:latest`].includes(m.id));

				if (baseModel) {
					model.base_model_id = baseModel.id;
				} else {
					model.base_model_id = null;
				}
			}

			system = model?.params?.system ?? '';

			params = { ...params, ...model?.params };
			params.stop = params?.stop
				? (typeof params.stop === 'string' ? params.stop.split(',') : (params?.stop ?? [])).join(
						','
					)
				: null;

			knowledge = (model?.meta?.knowledge ?? []).map((item) => {
				if (item?.collection_name && item?.type !== 'file') {
					return {
						id: item.collection_name,
						name: item.name,
						legacy: true
					};
				} else if (item?.collection_names) {
					return {
						name: item.name,
						type: 'collection',
						collection_names: item.collection_names,
						legacy: true
					};
				}

				return item;
			});

			toolIds = model?.meta?.toolIds ?? [];
			filterIds = model?.meta?.filterIds ?? [];
			defaultFilterIds = model?.meta?.defaultFilterIds ?? [];
			actionIds = model?.meta?.actionIds ?? [];

			capabilities = { ...capabilities, ...(model?.meta?.capabilities ?? {}) };
			defaultFeatureIds = model?.meta?.defaultFeatureIds ?? [];

			if ('access_control' in model) {
				accessControl = model.access_control;
			} else {
				accessControl = {};
			}

			info = {
				...info,
				...JSON.parse(
					JSON.stringify(
						model
							? model
							: {
									id: model.id,
									name: model.name
								}
					)
				)
			};
		}

		loaded = true;
	});
</script>

{#if loaded}
	<div class="mx-auto flex w-full max-w-6xl flex-col gap-4 pb-8">
		{#if onBack}
			<button
				class="flex w-fit items-center gap-1.5 rounded-full px-1 py-1 text-sm font-medium text-gray-500 transition hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
				type="button"
				on:click={() => {
					onBack();
				}}
			>
				<div class="self-center">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 20 20"
						fill="currentColor"
						class="h-4 w-4"
					>
						<path
							fill-rule="evenodd"
							d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z"
							clip-rule="evenodd"
						/>
					</svg>
				</div>
				<div>{$i18n.t('Back')}</div>
			</button>
		{/if}

		<input
			bind:this={filesInputElement}
			bind:files={inputFiles}
			type="file"
			hidden
			accept="image/*"
			on:change={() => {
				let reader = new FileReader();
				reader.onload = (event) => {
					let originalImageUrl = `${event.target?.result}`;

					const img = new Image();
					img.src = originalImageUrl;

					img.onload = function () {
						const canvas = document.createElement('canvas');
						const ctx = canvas.getContext('2d');

						const aspectRatio = img.width / img.height;

						let newWidth, newHeight;
						if (aspectRatio > 1) {
							newWidth = 250 * aspectRatio;
							newHeight = 250;
						} else {
							newWidth = 250;
							newHeight = 250 / aspectRatio;
						}

						canvas.width = 250;
						canvas.height = 250;

						const offsetX = (250 - newWidth) / 2;
						const offsetY = (250 - newHeight) / 2;

						ctx.drawImage(img, offsetX, offsetY, newWidth, newHeight);

						const compressedSrc = canvas.toDataURL();

						info.meta.profile_image_url = compressedSrc;

						inputFiles = null;
						filesInputElement.value = '';
					};
				};

				if (
					inputFiles &&
					inputFiles.length > 0 &&
					['image/gif', 'image/webp', 'image/jpeg', 'image/png', 'image/svg+xml'].includes(
						inputFiles[0]?.type
					)
				) {
					reader.readAsDataURL(inputFiles[0]);
				} else {
					inputFiles = null;
				}
			}}
		/>

		{#if !edit || (edit && model)}
			<form
				class="flex w-full flex-col items-start gap-5 md:flex-row"
				on:submit|preventDefault={() => {
					submitHandler();
				}}
			>
				<aside class="w-full self-start md:sticky md:top-5 md:w-[18rem] md:max-w-[18rem] md:flex-none">
					<div class="rounded-[2rem] border border-gray-200/60 bg-white/90 p-4 shadow-[0_20px_70px_-36px_rgba(0,0,0,0.55)] dark:border-gray-800 dark:bg-gray-900/90">
						<button
							class="group relative flex w-full items-center justify-center overflow-hidden rounded-[1.6rem] border border-gray-200/70 bg-gray-50/80 shadow-sm transition hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950/70 dark:hover:border-gray-700"
							type="button"
							on:click={() => {
								filesInputElement.click();
							}}
						>
							{#if info.meta.profile_image_url}
								<img
									src={info.meta.profile_image_url}
									alt="agent profile"
									class="aspect-square w-full rounded-[1.6rem] bg-white p-6 object-contain dark:bg-gray-900"
								/>
							{:else}
								<img
									src={`${WEBUI_BASE_URL}/static/favicon.png`}
									alt="agent profile"
									class="aspect-square w-full rounded-[1.6rem] bg-white p-6 object-contain dark:bg-gray-900"
								/>
							{/if}

							<div class="absolute bottom-3 right-3 z-10">
								<div
									class="rounded-full border border-white/80 bg-gray-900/90 p-2 text-white shadow-xl transition group-hover:bg-gray-700 dark:border-black/60 dark:bg-white dark:text-black dark:group-hover:bg-gray-200"
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										viewBox="0 0 16 16"
										fill="currentColor"
										class="size-4.5"
									>
										<path
											fill-rule="evenodd"
											d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4Zm10.5 5.707a.5.5 0 0 0-.146-.353l-1-1a.5.5 0 0 0-.708 0L9.354 9.646a.5.5 0 0 1-.708 0L6.354 7.354a.5.5 0 0 0-.708 0l-2 2a.5.5 0 0 0-.146.353V12a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V9.707ZM12 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"
											clip-rule="evenodd"
										/>
									</svg>
								</div>
							</div>

							<div class="absolute inset-0 bg-black/0 transition group-hover:bg-black/5 dark:group-hover:bg-white/5"></div>
						</button>

						<div class="mt-3 flex items-center justify-between gap-3">
							<div>
								<div class="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">
									{$i18n.t('Visual Identity')}
								</div>
								<div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
									{$i18n.t('Upload a square icon so the agent is recognizable at a glance.')}
								</div>
							</div>

							<button
								class="rounded-full border border-gray-200/70 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:border-gray-300 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-600 dark:hover:text-white"
								on:click={() => {
									info.meta.profile_image_url = `${WEBUI_BASE_URL}/static/favicon.png`;
								}}
								type="button"
							>
								{$i18n.t('Reset Image')}
							</button>
						</div>

						<div class="mt-4 rounded-[1.4rem] border border-gray-200/60 bg-gray-50/80 p-4 dark:border-gray-800 dark:bg-gray-950/60">
							<div class="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">
								{$i18n.t('Agent Snapshot')}
							</div>

							<div class="mt-3 space-y-3">
								<div>
									<div class="text-xs font-medium text-gray-500 dark:text-gray-400">
										{$i18n.t('Name')}
									</div>
									<div class="mt-1 line-clamp-2 text-sm font-medium">
										{name || $i18n.t('Untitled Agent')}
									</div>
								</div>

								<div>
									<div class="text-xs font-medium text-gray-500 dark:text-gray-400">
										{$i18n.t('ID')}
									</div>
									<div class="mt-1 break-all text-xs text-gray-500 dark:text-gray-400">
										{id || $i18n.t('Generated from the agent name')}
									</div>
								</div>

								{#if preset}
									<div>
										<div class="text-xs font-medium text-gray-500 dark:text-gray-400">
											{$i18n.t('Base Model')}
										</div>
										<div class="mt-1 text-sm">
											{availableBaseModels.find((baseModel) => baseModel.id === info.base_model_id)
												?.name || $i18n.t('Select a base model')}
										</div>
									</div>
								{/if}
							</div>
						</div>
					</div>
				</aside>

				<div class="w-full min-w-0 space-y-5 md:flex-1">
					<section class="rounded-[2rem] border border-gray-200/60 bg-white/90 p-5 shadow-[0_20px_70px_-36px_rgba(0,0,0,0.55)] dark:border-gray-800 dark:bg-gray-900/90 md:p-6">
						<div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
							<div class="max-w-2xl">
								<div class="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">
									{$i18n.t('Identity')}
								</div>
								<h1 class="mt-2 text-3xl font-medium tracking-tight md:text-4xl">
									{edit ? $i18n.t('Refine Agent') : $i18n.t('Create Agent')}
								</h1>
								<p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
									{$i18n.t(
										'Give the agent a clear name, a strong base model, and just enough context to make it dependable.'
									)}
								</p>
							</div>

							<button
								class="inline-flex items-center justify-center rounded-full bg-black px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-900 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-white dark:text-black dark:hover:bg-gray-100"
								type="submit"
								disabled={loading}
							>
								{primaryActionLabel}
								{#if loading}
									<div class="ml-2 self-center">
										<Spinner />
									</div>
								{/if}
							</button>
						</div>

						<div class="mt-6 grid gap-4 md:grid-cols-2">
							<div class="space-y-2">
								<label class="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400">
									{$i18n.t('Agent Name')}
								</label>
								<input
									class="w-full rounded-2xl border border-gray-200/70 bg-gray-50/85 px-4 py-3 text-base outline-hidden transition focus:border-gray-300 focus:bg-white dark:border-gray-800 dark:bg-gray-950/60 dark:focus:border-gray-700 dark:focus:bg-gray-950"
									placeholder={$i18n.t('Agent Name')}
									bind:value={name}
									required
								/>
							</div>

							<div class="space-y-2">
								<label class="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400">
									{$i18n.t('Agent ID')}
								</label>
								<input
									class="w-full rounded-2xl border border-gray-200/70 bg-gray-50/85 px-4 py-3 text-sm outline-hidden transition focus:border-gray-300 focus:bg-white disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-800 dark:bg-gray-950/60 dark:focus:border-gray-700 dark:focus:bg-gray-950"
									placeholder={$i18n.t('Agent ID')}
									bind:value={id}
									disabled={edit}
									required
								/>
							</div>
						</div>

						{#if preset}
							<div class="mt-4 space-y-2">
								<label class="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400">
									{$i18n.t('Base Model (From)')}
								</label>
								<select
									class="w-full rounded-2xl border border-gray-200/70 bg-gray-50/85 px-4 py-3 text-sm outline-hidden transition focus:border-gray-300 focus:bg-white dark:border-gray-800 dark:bg-gray-950/60 dark:focus:border-gray-700 dark:focus:bg-gray-950"
									placeholder={$i18n.t('Select a base model (e.g. llama3, gpt-4o)')}
									bind:value={info.base_model_id}
									required
								>
									<option value={null} class="text-gray-900">
										{$i18n.t('Select a base model')}
									</option>
									{#each availableBaseModels as baseModel}
										<option value={baseModel.id} class="text-gray-900">
											{baseModel.name}
										</option>
									{/each}
								</select>
							</div>
						{/if}

						<div class="mt-5 space-y-2">
							<div class="flex items-center justify-between gap-3">
								<label class="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400">
									{$i18n.t('Description')}
								</label>

								<button
									class="rounded-full border border-gray-200/70 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:border-gray-300 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-600 dark:hover:text-white"
									type="button"
									aria-pressed={enableDescription ? 'true' : 'false'}
									aria-label={enableDescription
										? $i18n.t('Custom description enabled')
										: $i18n.t('Default description enabled')}
									on:click={() => {
										enableDescription = !enableDescription;
									}}
								>
									{#if enableDescription}
										{$i18n.t('Custom')}
									{:else}
										{$i18n.t('Default')}
									{/if}
								</button>
							</div>

							{#if enableDescription}
								<Textarea
									className="w-full rounded-2xl border border-gray-200/70 bg-gray-50/85 px-4 py-3 text-sm outline-hidden transition focus-within:border-gray-300 focus-within:bg-white dark:border-gray-800 dark:bg-gray-950/60 dark:focus-within:border-gray-700 dark:focus-within:bg-gray-950"
									placeholder={$i18n.t('Add a short description about what this model does')}
									bind:value={info.meta.description}
									rows={3}
								/>
							{/if}
						</div>

						<div class="mt-5 space-y-2">
							<label class="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400">
								{$i18n.t('Tags')}
							</label>
							<div class="rounded-[1.4rem] border border-dashed border-gray-200/80 bg-gray-50/70 px-3 py-3 dark:border-gray-800 dark:bg-gray-950/50">
								<Tags
									tags={info?.meta?.tags ?? []}
									on:delete={(e) => {
										const tagName = e.detail;
										info.meta.tags = info.meta.tags.filter((tag) => tag.name !== tagName);
									}}
									on:add={(e) => {
										const tagName = e.detail;
										if (!(info?.meta?.tags ?? null)) {
											info.meta.tags = [{ name: tagName }];
										} else {
											info.meta.tags = [...info.meta.tags, { name: tagName }];
										}
									}}
								/>
							</div>
						</div>
					</section>

					<section class="rounded-[2rem] border border-gray-200/60 bg-white/90 p-5 shadow-[0_20px_70px_-36px_rgba(0,0,0,0.55)] dark:border-gray-800 dark:bg-gray-900/90 md:p-6">
						<div class="max-w-2xl">
							<div class="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">
								{$i18n.t('Agent Params')}
							</div>
							<h2 class="mt-2 text-lg font-medium">{$i18n.t('System Prompt')}</h2>
							<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
								{$i18n.t(
									'Write the core behavior, tone, and operating constraints that should shape every response.'
								)}
							</p>
						</div>

						<div class="mt-4">
							<Textarea
								className="min-h-[14rem] w-full rounded-[1.5rem] border border-gray-200/70 bg-gray-50/85 px-4 py-4 text-sm outline-hidden transition focus-within:border-gray-300 focus-within:bg-white dark:border-gray-800 dark:bg-gray-950/60 dark:focus-within:border-gray-700 dark:focus-within:bg-gray-950"
								placeholder={$i18n.t(
									'Write your agent system prompt content here\ne.g.) You are Mario from Super Mario Bros, acting as an assistant.'
								)}
								rows={10}
								bind:value={system}
							/>
						</div>
					</section>

					<section class="rounded-[2rem] border border-gray-200/60 bg-white/90 p-5 shadow-[0_20px_70px_-36px_rgba(0,0,0,0.55)] dark:border-gray-800 dark:bg-gray-900/90 md:p-6">
						<div class="mb-4 max-w-2xl">
							<div class="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">
								{$i18n.t('Toolkit')}
							</div>
							<h2 class="mt-2 text-lg font-medium">{$i18n.t('Tools')}</h2>
							<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
								{$i18n.t('Choose the tools this agent can use. Hidden capabilities remain intact behind the scenes.')}
							</p>
						</div>

						<ToolsSelector bind:selectedToolIds={toolIds} tools={$tools ?? []} />
					</section>

					{#if ($functions ?? []).filter((func) => func.type === 'action').length > 0}
						<section class="rounded-[2rem] border border-gray-200/60 bg-white/90 p-5 shadow-[0_20px_70px_-36px_rgba(0,0,0,0.55)] dark:border-gray-800 dark:bg-gray-900/90 md:p-6">
							<div class="mb-4 max-w-2xl">
								<div class="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">
									{$i18n.t('Automation')}
								</div>
								<h2 class="mt-2 text-lg font-medium">{$i18n.t('Actions')}</h2>
								<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
									{$i18n.t('Attach reusable actions without surfacing the rest of the advanced configuration UI.')}
								</p>
							</div>

							<ActionsSelector
								bind:selectedActionIds={actionIds}
								actions={($functions ?? []).filter((func) => func.type === 'action')}
							/>
						</section>
					{/if}

					<div class="flex justify-end pb-2">
						<button
							class="inline-flex items-center justify-center rounded-full bg-black px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-900 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-white dark:text-black dark:hover:bg-gray-100"
							type="submit"
							disabled={loading}
						>
							{primaryActionLabel}
							{#if loading}
								<div class="ml-2 self-center">
									<Spinner />
								</div>
							{/if}
						</button>
					</div>
				</div>
			</form>
		{/if}
	</div>
{/if}
