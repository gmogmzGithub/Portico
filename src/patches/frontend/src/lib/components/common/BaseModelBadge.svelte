<script lang="ts">
	import { getContext } from 'svelte';

	import MaybeTooltip from '$lib/components/common/MaybeTooltip.svelte';
	import { WEBUI_API_BASE_URL, WEBUI_BASE_URL } from '$lib/constants';
	import { models, type Model } from '$lib/stores';
	import {
		getModelLogoSources,
		usesCelestialModelLogo,
		usesDarkLogoBadgeInLightMode
	} from '$lib/utils/modelBranding';

	const i18n = getContext('i18n');

	export let model: Record<string, any> | null | undefined = null;
	export let showTooltip = true;
	export let className =
		'inline-flex max-w-full items-center gap-1.5 rounded-full border border-gray-200/80 bg-gray-100/70 px-2 py-1 text-[0.68rem] leading-none text-gray-600 dark:border-gray-700 dark:bg-gray-800/70 dark:text-gray-300';

	const normalizeModelValue = (value: unknown) => {
		const normalized = `${value ?? ''}`.trim();
		return normalized && normalized !== 'null' && normalized !== 'undefined' ? normalized : '';
	};

	const getAgentBaseModelId = (candidateModel: Record<string, any> | null | undefined) => {
		const info = candidateModel?.info ?? {};
		return normalizeModelValue(
			candidateModel?.base_model_id ??
				candidateModel?.baseModelId ??
				info?.base_model_id ??
				info?.baseModelId
		);
	};

	const getAgentBaseModelName = (candidateModel: Record<string, any> | null | undefined) => {
		const info = candidateModel?.info ?? {};
		return normalizeModelValue(
			info?.base_model_name ??
				info?.baseModelName ??
				candidateModel?.base_model_name ??
				candidateModel?.baseModelName ??
				getAgentBaseModelId(candidateModel)
		);
	};

	const getAgentBaseModelRecord = (modelId: string): Model | Record<string, any> | null => {
		if (!modelId) {
			return null;
		}

		return ($models ?? []).find((candidate) => candidate?.id === modelId) ?? { id: modelId };
	};

	const handleBaseModelImageError = (event: Event) => {
		const img = event.target as HTMLImageElement;
		img.src = `${WEBUI_BASE_URL}/static/favicon.png`;
	};

	$: agentBaseModelId = getAgentBaseModelId(model);
	$: agentBaseModelName = getAgentBaseModelName(model);
	$: agentBaseModelRecord = getAgentBaseModelRecord(agentBaseModelId);
	$: agentBaseModelLogoSources = getModelLogoSources(
		agentBaseModelRecord,
		WEBUI_API_BASE_URL,
		$i18n?.language || 'en',
		`${WEBUI_BASE_URL}/static/favicon.png`
	);
	$: baseModelNeedsDarkLogoBadge = usesDarkLogoBadgeInLightMode(agentBaseModelRecord ?? {
		id: agentBaseModelId,
		name: agentBaseModelName
	});
	$: baseModelUsesCelestialLogo = usesCelestialModelLogo(agentBaseModelRecord ?? {
		id: agentBaseModelId,
		name: agentBaseModelName
	});
</script>

{#if agentBaseModelId}
	<MaybeTooltip
		enabled={showTooltip}
		content={`${$i18n.t('Base model')}: ${agentBaseModelName}`}
		placement="top-start"
	>
		<div class={className}>
			<div
				class={`shrink-0 rounded-full ${baseModelNeedsDarkLogoBadge ? 'bg-black p-[1px] shadow-sm ring-1 ring-black/10 dark:bg-transparent dark:p-0 dark:shadow-none dark:ring-0' : ''}`.trim()}
			>
				{#if agentBaseModelLogoSources.dark}
					<img
						src={agentBaseModelLogoSources.light}
						alt={agentBaseModelName}
						class="size-3.5 shrink-0 rounded-full object-cover dark:hidden {baseModelUsesCelestialLogo ? 'celestial-model-logo' : ''}"
						loading="lazy"
						decoding="async"
						on:error={handleBaseModelImageError}
					/>
					<img
						src={agentBaseModelLogoSources.dark ?? agentBaseModelLogoSources.light}
						alt={agentBaseModelName}
						class="hidden size-3.5 shrink-0 rounded-full object-cover dark:block {baseModelUsesCelestialLogo ? 'celestial-model-logo' : ''}"
						loading="lazy"
						decoding="async"
						on:error={handleBaseModelImageError}
					/>
				{:else}
					<img
						src={agentBaseModelLogoSources.light}
						alt={agentBaseModelName}
						class="size-3.5 shrink-0 rounded-full object-cover {baseModelUsesCelestialLogo ? 'celestial-model-logo' : ''}"
						loading="lazy"
						decoding="async"
						on:error={handleBaseModelImageError}
					/>
				{/if}
			</div>

			<span class="truncate">{agentBaseModelName}</span>
		</div>
	</MaybeTooltip>
{/if}
