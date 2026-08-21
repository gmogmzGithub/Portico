<script lang="ts">
	import { getContext } from 'svelte';
	import { models } from '$lib/stores';
	import { WEBUI_API_BASE_URL, WEBUI_BASE_URL } from '$lib/constants';
	import ProfileImage from '$lib/components/chat/Messages/ProfileImage.svelte';
	import {
		getModelLogoSources,
		getModelSelectorLogoPresentation,
		isDerivedModelCandidate,
		resolveBaseModelRecord,
		usesDarkLogoBadgeInLightMode
	} from '$lib/utils/modelBranding';

	const i18n = getContext('i18n');

	export let modelId: string | null = null;

	$: model = ($models ?? []).find((candidate) => candidate?.id === modelId) ??
		(modelId ? { id: modelId } : null);
	$: logoSources = getModelLogoSources(
		model,
		WEBUI_API_BASE_URL,
		$i18n?.language || 'en',
		`${WEBUI_BASE_URL}/static/favicon.png`
	);
	$: presentation = getModelSelectorLogoPresentation(model, 'sidebar');
	$: modelLabel = model?.name ?? modelId ?? $i18n.t('Unknown model');

	// Agent chats (derived models with a base_model_id) show TWO stacked icons:
	// the agent's own profile image (the PORTICO "ai" logo by default) in front-left
	// on top, with the BASE model's brand logo peeking out behind, shifted right.
	$: isAgentModel = model ? isDerivedModelCandidate(model) : false;
	$: baseModel = isAgentModel ? resolveBaseModelRecord(model, $models) : null;
	$: baseLogoSources =
		isAgentModel && baseModel
			? getModelLogoSources(
					baseModel,
					WEBUI_API_BASE_URL,
					$i18n?.language || 'en',
					`${WEBUI_BASE_URL}/static/favicon.png`
				)
			: null;
	$: baseModelLabel = baseModel?.name ?? baseModel?.id ?? '';
	// White-glyph logos (plain OpenAI gpt.png) need the same dark chip in light
	// mode that the non-stacked path gets via presentation.wrapperClassName.
	$: baseBadgeClass =
		baseModel && usesDarkLogoBadgeInLightMode(baseModel)
			? ' bg-black p-[2px] dark:bg-transparent dark:p-0'
			: '';
</script>

{#if modelId}
	{#if isAgentModel && baseLogoSources}
		<span
			class="sidebar-model-logo-stack shrink-0"
			role="img"
			aria-label={$i18n.t('Model: {{MODEL}}', { MODEL: modelLabel })}
			title={baseModelLabel ? `${modelLabel} · ${baseModelLabel}` : modelLabel}
		>
			{#if baseLogoSources.dark}
				<ProfileImage
					src={baseLogoSources.light}
					className={`sidebar-model-logo-stack-base dark:hidden${baseBadgeClass}`}
				/>
				<ProfileImage
					src={baseLogoSources.dark}
					className="sidebar-model-logo-stack-base hidden dark:block"
				/>
			{:else}
				<ProfileImage
					src={baseLogoSources.light}
					className={`sidebar-model-logo-stack-base${baseBadgeClass}`}
				/>
			{/if}
			<ProfileImage src={logoSources.light} className="sidebar-model-logo-stack-front" />
		</span>
		{:else}
		<span
			class={presentation.wrapperClassName}
			role="img"
			aria-label={$i18n.t('Model: {{MODEL}}', { MODEL: modelLabel })}
			title={modelLabel}
		>
			{#if logoSources.dark}
				<ProfileImage
					src={logoSources.light}
					className={`${presentation.imageClassName} dark:hidden`}
				/>
				<ProfileImage
					src={logoSources.dark}
					className={`${presentation.imageClassName} hidden dark:block`}
				/>
			{:else}
				<ProfileImage src={logoSources.light} className={presentation.imageClassName} />
			{/if}
		</span>
	{/if}
{/if}

<style>
	.sidebar-model-logo-stack {
		position: relative;
		display: inline-flex;
		width: 1.45rem;
		height: 1rem;
	}

	.sidebar-model-logo-stack :global(.sidebar-model-logo-stack-base) {
		position: absolute;
		top: 0.0625rem;
		left: 0.55rem;
		width: 0.875rem;
		height: 0.875rem;
	}

	.sidebar-model-logo-stack :global(.sidebar-model-logo-stack-front) {
		position: absolute;
		top: 0;
		left: 0;
		width: 0.95rem;
		height: 0.95rem;
		z-index: 1;
	}
</style>
