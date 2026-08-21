<script lang="ts">
	import { getContext } from 'svelte';
	import dayjs from '$lib/dayjs';

	import { models, user } from '$lib/stores';
	import { WEBUI_API_BASE_URL, WEBUI_BASE_URL } from '$lib/constants';

	import MaybeTooltip from '$lib/components/common/MaybeTooltip.svelte';
	import { copyToClipboard } from '$lib/utils';
	import ArrowUpTray from '$lib/components/icons/ArrowUpTray.svelte';
	import Check from '$lib/components/icons/Check.svelte';
	import ModelItemMenu from './ModelItemMenu.svelte';
	import EllipsisHorizontal from '$lib/components/icons/EllipsisHorizontal.svelte';
	import { toast } from 'svelte-sonner';
	import Tag from '$lib/components/icons/Tag.svelte';
	import Label from '$lib/components/icons/Label.svelte';
	import ModelTraitBadges from '$lib/components/common/ModelTraitBadges.svelte';
	import BaseModelBadge from '$lib/components/common/BaseModelBadge.svelte';
	import { resolveModelTraitKeysForModel } from '$lib/config/model-traits';
	import {
		buildModelLogoUrl,
		fetchAndCacheModelLogo,
		getCachedModelLogoUrl,
		getModelLogoCacheKey,
		getModelLogoCacheVersion
	} from '$lib/utils/modelLogoCache';
	import { getModelDescriptionHtml } from '$lib/utils/modelDescriptionCache';
	import {
		getCelestialModelIdentity,
		getModelLogoSources,
		getModelSelectorLogoPresentation,
		isLocalModelCandidate,
		usesStaticModelLogo
	} from '$lib/utils/modelBranding';
	import { getModelAvailability } from '$lib/utils/modelAvailability';

	const i18n = getContext('i18n');

	export let selectedModelIdx: number = -1;
	export let item: any = {};
	export let index: number = -1;
	export let value: string = '';
	export let disableTooltips = false;

	export let unloadModelHandler: (modelValue: string) => void = () => {};
	export let pinModelHandler: (modelId: string) => void = () => {};

	export let onClick: () => void = () => {};

	const copyLinkHandler = async (model) => {
		const baseUrl = window.location.origin;
		const res = await copyToClipboard(`${baseUrl}/?model=${encodeURIComponent(model.id)}`);

		if (res) {
			toast.success($i18n.t('Copied link to clipboard'));
		} else {
			toast.error($i18n.t('Failed to copy link'));
		}
	};

	let showMenu = false;
	let logoSrc = `${WEBUI_BASE_URL}/static/favicon.png`;
	let logoLoadVersion = 0;
	let activeLogoCacheKey = '';
	let modelDescriptionHtml = '';
	let modelTraitKeys = [];
	let isDisabled = false;
	let keepDisabledTraitBadgeVivid = false;
	let disabledTooltipContent = '';
	let selectorLogoPresentation = getModelSelectorLogoPresentation(item, 'compact');
	let isLocalModel = false;
	let usesStaticLogo = false;
	let localLogoSources = getModelLogoSources(item, WEBUI_API_BASE_URL, 'en', `${WEBUI_BASE_URL}/static/favicon.png`);

	const loadModelLogo = async (modelId: string, language: string, cacheKey: string, version: string) => {
		const logoUrl = buildModelLogoUrl(WEBUI_API_BASE_URL, modelId, language, version);
		const cachedLogoUrl = getCachedModelLogoUrl(cacheKey);

		if (cachedLogoUrl) {
			logoSrc = cachedLogoUrl;
			return;
		}

		// Keep a stable fallback while fetching so each model logo is requested once.
		logoSrc = `${WEBUI_BASE_URL}/static/favicon.png`;

		const currentLoadVersion = ++logoLoadVersion;
		try {
			const cachedLogoUrl = await fetchAndCacheModelLogo(logoUrl, cacheKey);
			if (currentLoadVersion === logoLoadVersion && activeLogoCacheKey === cacheKey) {
				logoSrc = cachedLogoUrl;
			}
		} catch {
			// Keep the fallback icon if preload fails.
		}
	};

	const handleModelImageError = (event: Event) => {
		const img = event.target as HTMLImageElement;
		img.src = `${WEBUI_BASE_URL}/static/favicon.png`;
	};

	$: modelDescriptionHtml = getModelDescriptionHtml(item?.model?.info?.meta?.description ?? '');
	$: modelTraitKeys = resolveModelTraitKeysForModel(item?.model ?? null);
	$: keepDisabledTraitBadgeVivid =
		getCelestialModelIdentity(item) === 'sol' && modelTraitKeys.includes('premium');
	$: isLocalModel = isLocalModelCandidate(item);
	$: usesStaticLogo = usesStaticModelLogo(item);
	$: {
		const availability = getModelAvailability(item?.model ?? null, $models ?? []);
		isDisabled = availability.disabled;
		disabledTooltipContent = availability.disabledReason ?? $i18n.t('Temporarily unavailable');
	}
	$: selectorLogoPresentation = getModelSelectorLogoPresentation(item, 'compact');
	$: localLogoSources = getModelLogoSources(
		item,
		WEBUI_API_BASE_URL,
		$i18n?.language || 'en',
		`${WEBUI_BASE_URL}/static/favicon.png`
	);

	$: {
		const modelId = item?.model?.id;
		const language = $i18n?.language || 'en';

		if (isLocalModel || usesStaticLogo) {
			activeLogoCacheKey = '';
			logoSrc = localLogoSources.light;
		} else if (!modelId) {
			activeLogoCacheKey = '';
			logoSrc = `${WEBUI_BASE_URL}/static/favicon.png`;
		} else {
			const version = getModelLogoCacheVersion(item?.model);
			const cacheKey = getModelLogoCacheKey(modelId, language, version);
			if (cacheKey !== activeLogoCacheKey) {
				activeLogoCacheKey = cacheKey;
				void loadModelLogo(modelId, language, cacheKey, version);
			}
		}
	}
</script>

<button
	aria-roledescription="model-item"
	aria-label={item.label}
	aria-disabled={isDisabled}
	class="group/item flex min-h-11 w-full select-none items-center rounded-lg border border-transparent py-1.5 pl-2 pr-1.5 text-left text-sm font-medium text-slate-700 outline-none transition-colors focus-visible:border-slate-400 focus-visible:ring-2 focus-visible:ring-slate-400/25 data-highlighted:bg-muted dark:text-gray-100 dark:focus-visible:border-gray-700 dark:focus-visible:ring-gray-700/40 {isDisabled
		? 'cursor-not-allowed border-transparent bg-transparent text-slate-400 dark:border-transparent dark:bg-transparent dark:text-gray-500'
		: 'cursor-pointer hover:bg-slate-300/70 dark:hover:bg-gray-800'} {index ===
	selectedModelIdx && !isDisabled
		? 'bg-slate-300/80 dark:bg-gray-800 dark:group-hover:bg-gray-800'
		: ''}"
	data-arrow-selected={index === selectedModelIdx}
	data-value={item.value}
	on:click={() => {
		if (isDisabled) {
			return;
		}
		onClick();
	}}
>
	<div class="flex min-w-0 flex-col flex-1 gap-1.5">
		<!-- {#if (item?.model?.tags ?? []).length > 0}
			<div
				class="flex gap-0.5 self-center items-start h-full w-full translate-y-[0.5px] overflow-x-auto scrollbar-none"
			>
				{#each item.model?.tags.sort((a, b) => a.name.localeCompare(b.name)) as tag}
					<Tooltip content={tag.name} className="flex-shrink-0">
						<div
							class=" text-xs font-semibold px-1 rounded-sm uppercase bg-gray-500/20 text-gray-700 dark:text-gray-200"
						>
							{tag.name}
						</div>
					</Tooltip>
				{/each}
			</div>
		{/if} -->

		<div class="flex min-w-0 items-center gap-2">
			<div class="flex items-center min-w-fit">
				<MaybeTooltip
					enabled={!disableTooltips}
					content={$user?.role === 'admin' ? (item?.value ?? '') : ''}
					placement="top-start"
				>
					<div class={`${selectorLogoPresentation.wrapperClassName} ${isDisabled ? 'opacity-50 grayscale' : ''}`.trim()}>
						{#if isLocalModel}
							<img
								src={localLogoSources.light}
								alt="Model"
								class="{selectorLogoPresentation.imageClassName} dark:hidden"
								loading="lazy"
								decoding="async"
							/>
							<img
								src={localLogoSources.dark ?? localLogoSources.light}
								alt="Model"
								class="{selectorLogoPresentation.imageClassName} hidden dark:block"
								loading="lazy"
								decoding="async"
							/>
						{:else}
							<img
								src={logoSrc}
								alt="Model"
								class={selectorLogoPresentation.imageClassName}
								loading="lazy"
								decoding="async"
								on:error={handleModelImageError}
							/>
						{/if}
					</div>
				</MaybeTooltip>
			</div>

			<div class="min-w-0 flex flex-1 flex-col">
				<MaybeTooltip enabled={!disableTooltips} content={`${item.label} (${item.value})`} placement="top-start">
			<div class="min-w-0 whitespace-normal leading-tight {value === item.value && !isDisabled ? 'font-bold' : ''}">
						{item.label}
					</div>
				</MaybeTooltip>

				{#if item?.model}
					<div class="mt-1 min-w-0">
						<BaseModelBadge model={item.model} showTooltip={!disableTooltips} />
					</div>
				{/if}
			</div>

			<div class=" shrink-0 flex items-center gap-2">
				{#if isDisabled}
					<MaybeTooltip enabled={!disableTooltips} content={disabledTooltipContent} placement="top">
						<div class="flex items-center text-slate-400 dark:text-gray-500" aria-label={disabledTooltipContent}>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 20 20"
								fill="currentColor"
								class="size-4"
								aria-hidden="true"
							>
								<path
									fill-rule="evenodd"
									d="M5.75 8a4.25 4.25 0 118.5 0v1.293A3.25 3.25 0 0117 12.5v3A3.5 3.5 0 0113.5 19h-7A3.5 3.5 0 013 15.5v-3a3.25 3.25 0 012.75-3.207V8zm7 1.25V8a2.75 2.75 0 10-5.5 0v1.25h5.5z"
									clip-rule="evenodd"
								/>
							</svg>
						</div>
					</MaybeTooltip>
				{/if}

				{#if item.model.owned_by === 'ollama'}
					{#if (item.model.ollama?.details?.parameter_size ?? '') !== ''}
						<div class="flex items-center translate-y-[0.5px]">
							<MaybeTooltip
								enabled={!disableTooltips}
								content={`${
									item.model.ollama?.details?.quantization_level
										? item.model.ollama?.details?.quantization_level + ' '
										: ''
								}${
									item.model.ollama?.size
										? `(${(item.model.ollama?.size / 1024 ** 3).toFixed(1)}GB)`
										: ''
								}`}
								className="self-end"
							>
								<span class=" text-xs font-medium text-gray-600 dark:text-gray-400 line-clamp-1"
									>{item.model.ollama?.details?.parameter_size ?? ''}</span
								>
							</MaybeTooltip>
						</div>
					{/if}
					{#if item.model.ollama?.expires_at && new Date(item.model.ollama?.expires_at * 1000) > new Date()}
						<div class="flex items-center translate-y-[0.5px] px-0.5">
							<MaybeTooltip
								enabled={!disableTooltips}
								content={`${$i18n.t('Unloads {{FROM_NOW}}', {
									FROM_NOW: dayjs(item.model.ollama?.expires_at * 1000).fromNow()
								})}`}
								className="self-end"
							>
								<div class=" flex items-center">
									<span class="relative flex size-2">
										<span
											class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"
										></span>
										<span class="relative inline-flex rounded-full size-2 bg-green-500"></span>
									</span>
								</div>
							</MaybeTooltip>
						</div>
					{/if}
				{/if}

				<!-- {JSON.stringify(item.info)} -->

				{#if (item?.model?.tags ?? []).length > 0}
					{#key item.model.id}
						<MaybeTooltip enabled={!disableTooltips} elementId="tags-{item.model.id}">
							<div slot="tooltip" id="tags-{item.model.id}">
								{#each item.model?.tags.sort((a, b) => a.name.localeCompare(b.name)) as tag}
									<MaybeTooltip enabled={!disableTooltips} content={tag.name} className="flex-shrink-0">
										<div class=" text-xs font-medium rounded-sm uppercase text-white">
											{tag.name}
										</div>
									</MaybeTooltip>
								{/each}
							</div>

							<div class="translate-y-[1px]">
								<Tag />
							</div>
						</MaybeTooltip>
					{/key}
				{/if}

				{#if item.model?.direct}
					<MaybeTooltip enabled={!disableTooltips} content={`${$i18n.t('Direct')}`}>
						<div class="translate-y-[1px]">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 16 16"
								fill="currentColor"
								class="size-3"
							>
								<path
									fill-rule="evenodd"
									d="M2 2.75A.75.75 0 0 1 2.75 2C8.963 2 14 7.037 14 13.25a.75.75 0 0 1-1.5 0c0-5.385-4.365-9.75-9.75-9.75A.75.75 0 0 1 2 2.75Zm0 4.5a.75.75 0 0 1 .75-.75 6.75 6.75 0 0 1 6.75 6.75.75.75 0 0 1-1.5 0C8 10.35 5.65 8 2.75 8A.75.75 0 0 1 2 7.25ZM3.5 11a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"
									clip-rule="evenodd"
								/>
							</svg>
						</div>
					</MaybeTooltip>
				{:else if item.model.connection_type === 'external'}
					<MaybeTooltip enabled={!disableTooltips} content={`${$i18n.t('External')}`}>
						<div class="translate-y-[1px]">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 16 16"
								fill="currentColor"
								class="size-3"
							>
								<path
									fill-rule="evenodd"
									d="M8.914 6.025a.75.75 0 0 1 1.06 0 3.5 3.5 0 0 1 0 4.95l-2 2a3.5 3.5 0 0 1-5.396-4.402.75.75 0 0 1 1.251.827 2 2 0 0 0 3.085 2.514l2-2a2 2 0 0 0 0-2.828.75.75 0 0 1 0-1.06Z"
									clip-rule="evenodd"
								/>
								<path
									fill-rule="evenodd"
									d="M7.086 9.975a.75.75 0 0 1-1.06 0 3.5 3.5 0 0 1 0-4.95l2-2a3.5 3.5 0 0 1 5.396 4.402.75.75 0 0 1-1.251-.827 2 2 0 0 0-3.085-2.514l-2 2a2 2 0 0 0 0 2.828.75.75 0 0 1 0 1.06Z"
									clip-rule="evenodd"
								/>
							</svg>
						</div>
					</MaybeTooltip>
				{/if}

				{#if modelDescriptionHtml}
					<MaybeTooltip enabled={!disableTooltips} content={modelDescriptionHtml}>
						<div class=" translate-y-[1px]">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								fill="none"
								viewBox="0 0 24 24"
								stroke-width="1.5"
								stroke="currentColor"
								class="w-4 h-4"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z"
								/>
							</svg>
						</div>
					</MaybeTooltip>
				{/if}
			</div>
		</div>
	</div>

	<div class="ml-auto pl-2 pr-1 flex items-center gap-1.5 shrink-0">
		{#if value === item.value && !isDisabled}
			<div class="shrink-0">
				<Check className="size-3" />
			</div>
		{/if}

		<ModelTraitBadges
			traits={modelTraitKeys}
			className={isDisabled && !keepDisabledTraitBadgeVivid
				? 'shrink-0 opacity-50 grayscale'
				: 'shrink-0'}
			showTooltips={!disableTooltips}
		/>

		{#if $user?.role === 'admin' && item.model.owned_by === 'ollama' && item.model.ollama?.expires_at && new Date(item.model.ollama?.expires_at * 1000) > new Date()}
			<MaybeTooltip
				enabled={!disableTooltips}
				content={`${$i18n.t('Eject')}`}
				className="flex-shrink-0 group-hover/item:opacity-100 opacity-0 "
			>
				<button
					class="flex"
					on:click={(e) => {
						e.preventDefault();
						e.stopPropagation();
						unloadModelHandler(item.value);
					}}
				>
					<ArrowUpTray className="size-3" />
				</button>
			</MaybeTooltip>
		{/if}

		<ModelItemMenu
			bind:show={showMenu}
			model={item.model}
			{pinModelHandler}
			copyLinkHandler={() => {
				copyLinkHandler(item.model);
			}}
		>
			<button
				aria-label={`${$i18n.t('More Options')}`}
				class="flex"
				on:click={(e) => {
					e.preventDefault();
					e.stopPropagation();
					showMenu = !showMenu;
				}}
			>
				<EllipsisHorizontal />
			</button>
		</ModelItemMenu>

	</div>
</button>
