<script lang="ts">
	import { toast } from 'svelte-sonner';

	import fileSaver from 'file-saver';
	const { saveAs } = fileSaver;

	import { onMount, getContext } from 'svelte';
	import { goto } from '$app/navigation';
	const i18n = getContext('i18n');

	import { WEBUI_NAME, config, models as _models, settings, user } from '$lib/stores';
	import { WEBUI_API_BASE_URL, WEBUI_BASE_URL } from '$lib/constants';
	import {
		deleteModelById,
		getModelItems as getWorkspaceModels,
		getModelTags,
		toggleModelById,
		updateModelById
	} from '$lib/apis/models';

	import { getModels } from '$lib/apis';
	import { getGroups } from '$lib/apis/groups';

	import { copyToClipboard } from '$lib/utils';

	import EllipsisHorizontal from '../icons/EllipsisHorizontal.svelte';
	import ModelMenu from './Models/ModelMenu.svelte';
	import ModelDeleteConfirmDialog from '../common/ConfirmDialog.svelte';
	import GarbageBin from '../icons/GarbageBin.svelte';
	import Switch from '../common/Switch.svelte';
	import Spinner from '../common/Spinner.svelte';
	import EyeSlash from '../icons/EyeSlash.svelte';
	import Eye from '../icons/Eye.svelte';
	import TagSelector from './common/TagSelector.svelte';
	import Pagination from '../common/Pagination.svelte';
	import { getModelLogoSources, usesCelestialModelLogo } from '$lib/utils/modelBranding';

	let shiftKey = false;

	let tagsContainerElement: HTMLDivElement;

	let loaded = false;

	let showModelDeleteConfirm = false;

	let selectedModel = null;

	let groupIds = [];

	let tags = [];
	let selectedTag = '';
	let previousSelectedTag = '';

	let page = 1;
	let models = null;
	let total = null;

	let initialized = false;
	let requestSequence = 0;

	$: if (initialized && selectedTag !== previousSelectedTag) {
		previousSelectedTag = selectedTag;
		if (page !== 1) {
			page = 1;
		}
	}

	$: if (
		initialized &&
		page !== undefined &&
		selectedTag !== undefined
	) {
		getModelList();
	}

	const getModelList = async () => {
		const requestId = ++requestSequence;

		try {
			const res = await getWorkspaceModels(
				localStorage.token,
				'',
				'',
				selectedTag,
				null,
				null,
				page
			).catch((error) => {
				toast.error(`${error}`);
				return null;
			});

			if (res && requestId === requestSequence) {
				models = res.items;
				total = res.total;
			}
		} catch (err) {
			console.error(err);
		}
	};

	const loadModelTags = async () => {
		tags = await getModelTags(localStorage.token).catch((error) => {
			toast.error(`${error}`);
			return [];
		});
	};

	const deleteModelHandler = async (model) => {
		const res = await deleteModelById(localStorage.token, model.id).catch((e) => {
			toast.error(`${e}`);
			return null;
		});

		if (res) {
			toast.success($i18n.t(`Deleted {{name}}`, { name: model.id }));

			page = 1;
			await getModelList();
		}

		await _models.set(
			await getModels(
				localStorage.token,
				$config?.features?.enable_direct_connections && ($settings?.directConnections ?? null)
			)
		);
	};

	const cloneModelHandler = async (model) => {
		sessionStorage.model = JSON.stringify({
			...model,
			id: `${model.id}-clone`,
			name: `${model.name} (Clone)`
		});
		goto('/workspace/models/create');
	};

	const shareModelHandler = async (model) => {
		toast.success($i18n.t('Redirecting you to Open WebUI Community'));

		const url = 'https://openwebui.com';
		const tab = await window.open(`${url}/models/create`, '_blank');

		const messageHandler = (event) => {
			if (event.origin !== url) return;
			if (event.data === 'loaded') {
				tab.postMessage(JSON.stringify(model), '*');
				window.removeEventListener('message', messageHandler);
			}
		};

		window.addEventListener('message', messageHandler, false);
	};

	const hideModelHandler = async (model) => {
		model.meta = {
			...model.meta,
			hidden: !(model?.meta?.hidden ?? false)
		};

		const res = await updateModelById(localStorage.token, model.id, model);

		if (res) {
			toast.success(
				$i18n.t(`Model {{name}} is now {{status}}`, {
					name: model.id,
					status: model.meta.hidden ? 'hidden' : 'visible'
				})
			);

			page = 1;
			getModelList();
		}

		await _models.set(
			await getModels(
				localStorage.token,
				$config?.features?.enable_direct_connections && ($settings?.directConnections ?? null)
			)
		);
	};

	const copyLinkHandler = async (model) => {
		const baseUrl = window.location.origin;
		const res = await copyToClipboard(`${baseUrl}/?model=${encodeURIComponent(model.id)}`);

		if (res) {
			toast.success($i18n.t('Copied link to clipboard'));
		} else {
			toast.error($i18n.t('Failed to copy link'));
		}
	};

	const exportModelHandler = async (model) => {
		let blob = new Blob([JSON.stringify([model])], {
			type: 'application/json'
		});
		saveAs(blob, `${model.id}-${Date.now()}.json`);
	};

	onMount(async () => {
		page = 1;

		let groups = await getGroups(localStorage.token);
		groupIds = groups.map((group) => group.id);

		await loadModelTags();
		initialized = true;
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
		window.addEventListener('blur-sm', onBlur);

		return () => {
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('blur-sm', onBlur);
		};
	});
</script>

<svelte:head>
	<title>
		{$i18n.t('Agents')} • {$WEBUI_NAME}
	</title>
</svelte:head>

{#if loaded}
	<ModelDeleteConfirmDialog
		bind:show={showModelDeleteConfirm}
		on:confirm={() => {
			deleteModelHandler(selectedModel);
		}}
	/>

	<div class="workspace-page-shell mt-0 mb-2 flex flex-col gap-1 px-1">
	<div class="workspace-surface workspace-search-shell rounded-3xl border border-gray-100/30 py-2 dark:border-gray-850/30">
		{#if (tags ?? []).length > 0}
			<div
				class="flex w-full overflow-x-auto bg-transparent px-3 scrollbar-none"
				on:wheel={(e) => {
					if (e.deltaY !== 0) {
						e.preventDefault();
						e.currentTarget.scrollLeft += e.deltaY;
					}
				}}
			>
				<div
					class="flex w-fit whitespace-nowrap rounded-full bg-transparent px-0.5 text-center text-sm gap-0.5"
					bind:this={tagsContainerElement}
				>
					<TagSelector
						bind:value={selectedTag}
						items={tags.map((tag) => {
							return { value: tag, label: tag };
						})}
					/>
				</div>
			</div>
		{/if}

		{#if models !== null}
			{#if (models ?? []).length !== 0}
					<div class="workspace-card-grid workspace-model-grid my-2 grid gap-1 px-3 lg:grid-cols-2 lg:gap-2" id="model-list">
						{#each models as model (model.id)}
							{@const modelLogoSources = getModelLogoSources(
								model,
								WEBUI_API_BASE_URL,
								$i18n.language,
								`${WEBUI_BASE_URL}/static/favicon.png`
							)}
							<div
								class="workspace-card workspace-model-card workspace-list-row flex w-full cursor-pointer rounded-2xl p-2.5 transition dark:hover:bg-gray-850/50"
								id="model-item-{model.id}"
								on:click={() => {
									if (
										$user?.role === 'admin' ||
										model.user_id === $user?.id ||
										model.access_control.write.group_ids.some((wg) => groupIds.includes(wg))
									) {
										goto(`/workspace/models/edit?id=${encodeURIComponent(model.id)}`);
									}
								}}
							>
								<div class="flex w-full gap-3.5 group/item">
									<div class="self-start pl-0.5">
										<div class="workspace-card-icon-tile workspace-media-tile flex rounded-2xl">
											<div
												class="{model.is_active
													? ''
													: 'opacity-50 dark:opacity-50'} rounded-2xl bg-transparent"
											>
												<img
													src={modelLogoSources.light}
													alt="modelfile profile"
													class="workspace-card-icon-image size-12 rounded-2xl object-cover {usesCelestialModelLogo(model) ? 'celestial-model-logo' : ''}"
												/>
										</div>
									</div>
								</div>

								<div class="workspace-card-main min-w-0 shrink-0 flex w-full flex-1 self-center pr-1">
									<div class="group flex h-full w-full flex-1 flex-col justify-start self-center">
										<div class="w-full flex-1">
											<div class="workspace-card-top flex w-full items-start justify-between">
												<a
													class="workspace-card-title line-clamp-1 font-medium capitalize hover:underline"
													href={`/?models=${encodeURIComponent(model.id)}`}
													on:click|stopPropagation
												>
													{model.name}
												</a>

												<div class="workspace-card-actions flex items-center gap-1">
													<div
														class="flex w-full justify-end {model.is_active ? '' : 'text-gray-500'}"
													>
														<div class="flex w-full items-center justify-between">
															<div></div>
															<div class="flex flex-row items-center gap-0.5">
																{#if shiftKey}
																	<button
																		class="workspace-icon-btn self-center w-fit rounded-xl p-1.5 text-sm dark:text-white dark:hover:bg-white/5"
																		type="button"
																		on:click={(e) => {
																			e.stopPropagation();
																			hideModelHandler(model);
																		}}
																	>
																		{#if model?.meta?.hidden}
																			<EyeSlash />
																		{:else}
																			<Eye />
																		{/if}
																	</button>

																	<button
																		class="workspace-icon-btn self-center w-fit rounded-xl p-1.5 text-sm dark:text-white dark:hover:bg-white/5"
																		type="button"
																		on:click={(e) => {
																			e.stopPropagation();
																			deleteModelHandler(model);
																		}}
																	>
																		<GarbageBin />
																	</button>
																{:else}
																	<ModelMenu
																		user={$user}
																		{model}
																		editHandler={() => {
																			goto(
																				`/workspace/models/edit?id=${encodeURIComponent(model.id)}`
																			);
																		}}
																		shareHandler={() => {
																			shareModelHandler(model);
																		}}
																		cloneHandler={() => {
																			cloneModelHandler(model);
																		}}
																		exportHandler={() => {
																			exportModelHandler(model);
																		}}
																		hideHandler={() => {
																			hideModelHandler(model);
																		}}
																		copyLinkHandler={() => {
																			copyLinkHandler(model);
																		}}
																		deleteHandler={() => {
																			selectedModel = model;
																			showModelDeleteConfirm = true;
																		}}
																		onClose={() => {}}
																	>
																		<div
																			class="workspace-icon-btn self-center w-fit rounded-xl p-1 text-sm dark:text-white dark:hover:bg-white/5"
																		>
																			<EllipsisHorizontal className="size-5" />
																		</div>
																	</ModelMenu>
																{/if}
															</div>
														</div>
													</div>

													<button
														on:click={(e) => {
															e.stopPropagation();
														}}
													>
														<Switch
															bind:state={model.is_active}
															on:change={async () => {
																toggleModelById(localStorage.token, model.id);
																_models.set(
																	await getModels(
																		localStorage.token,
																		$config?.features?.enable_direct_connections &&
																			($settings?.directConnections ?? null)
																	)
																);
															}}
														/>
													</button>
												</div>
											</div>

											<div class="workspace-card-subtitle-row flex items-center gap-1 pr-2">
												<div class="workspace-pill workspace-id-pill">
													{model.id}
												</div>
											</div>

											<div class="workspace-card-description-wrap mt-2">
												<div class="workspace-card-description flex gap-1 overflow-hidden text-xs">
													<div class="line-clamp-2">
														{#if (model?.meta?.description ?? '').trim()}
															{model?.meta?.description}
														{:else}
															{$i18n.t('No description yet.')}
														{/if}
													</div>
												</div>
											</div>

											<div class="workspace-card-meta mt-3">
												<div class="workspace-pill {model.is_active ? 'is-enabled' : 'is-disabled'}">
													{model.is_active ? $i18n.t('Enabled') : $i18n.t('Disabled')}
												</div>
												{#if model?.meta?.hidden}
													<div class="workspace-pill is-muted">{$i18n.t('Hidden')}</div>
												{/if}
											</div>
										</div>
									</div>
								</div>
							</div>
						</div>
					{/each}
				</div>

				{#if total > 30}
					<Pagination bind:page count={total} perPage={30} />
				{/if}
			{:else}
				<div class="my-16 mb-24 flex h-full w-full flex-col items-center justify-center">
					<div class="max-w-md text-center">
						<div class="mb-3 text-3xl">😕</div>
						<div class="mb-1 text-lg font-medium">{$i18n.t('No agents found')}</div>
						<div class="workspace-empty-copy text-center text-xs">
							{$i18n.t('Try adjusting your search or filter to find what you are looking for.')}
						</div>
					</div>
				</div>
			{/if}
		{:else}
			<div class="flex h-full w-full items-center justify-center py-10">
				<Spinner className="size-4" />
			</div>
		{/if}
	</div>
	</div>
{:else}
	<div class="flex h-full w-full items-center justify-center">
		<Spinner className="size-5" />
	</div>
{/if}
