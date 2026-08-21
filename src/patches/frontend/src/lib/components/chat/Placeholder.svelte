<script lang="ts">
	import { getContext, createEventDispatcher } from 'svelte';
	import { fade } from 'svelte/transition';

	const dispatch = createEventDispatcher();

	import {
		config,
		models as _models,
		temporaryChatEnabled,
		selectedFolder,
		showSidebar
	} from '$lib/stores';
	import { refreshChatListPageOne } from '$lib/utils/chatListPagination';
	import Suggestions from './Suggestions.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import AnimatedAtlasLogo from '$lib/components/common/AnimatedAtlasLogo.svelte';
	import AnimatedTerraLogo from '$lib/components/common/AnimatedTerraLogo.svelte';
	import EyeSlash from '$lib/components/icons/EyeSlash.svelte';
	import MessageInput from './MessageInput.svelte';
	import FolderPlaceholder from './Placeholder/FolderPlaceholder.svelte';
	import FolderTitle from './Placeholder/FolderTitle.svelte';
	import { WEBUI_API_BASE_URL, WEBUI_BASE_URL } from '$lib/constants';
	import {
		getModelLogoSources,
		usesCelestialModelLogo,
		usesDarkLogoBadgeInLightMode
	} from '$lib/utils/modelBranding';
	import { resolveLandingHeroModel } from '$lib/utils/landingHeroModel';
	import {
		getAtlasModelLogoMotionTier,
		getStreamingModelLogoMotionKind,
		getStreamingModelLogoMotionStyle
	} from '$lib/utils/modelLogoMotion';

	const i18n = getContext('i18n');

	export let createMessagePair: Function;
	export let stopResponse: Function;

	export let autoScroll = false;

	export let atSelectedModel: Model | undefined;
	export let selectedModels: [''];

	export let history;

	export let prompt = '';
	export let files = [];
	export let messageInput = null;

	export let selectedToolIds = [];
	export let selectedFilterIds = [];

	export let showCommands = false;

	export let imageGenerationEnabled = false;
	export let codeInterpreterEnabled = false;
	export let webSearchEnabled = false;
	export let reasoningEffortByModel: Record<string, string> = {};
	export let reasoningEffortReady = false;
	// PORTICO PATCH (fast mode): lightning toggle state for the landing composer
	export let fastModeEnabled = false;
	export let onFastModeToggle: Function = () => {};
	export let reviewerWorkflowEnabled = false;
	export let reviewerWorkflowLocked = false;
	export let onReviewerWorkflowToggle: Function = () => {};
	export let reviewerWorkflowIntroVisible = false;
	export let reviewerWorkflowIntroRemaining = 0;
	export let onReviewerWorkflowIntroDismiss: Function = () => {};
	export let chatId = '';

	export let onUpload: Function = (e) => {};
	export let onSelect = (e) => {};
	export let onChange = (e) => {};
	export let onReasoningEffortSelect: Function = () => {};
	export let ensureChatId: Function | null = null;

	export let toolServers = [];

	let models = [];
	let selectedModelIdx = 0;

	$: if (selectedModels.length > 0) {
		selectedModelIdx = models.length - 1;
	}

	$: models = selectedModels.map((id) => $_models.find((m) => m.id === id));
	$: primaryModel = models[0];
	// An agent is a custom model whose info carries a base_model_id. When one is
	// selected we show the BASE model's (animated) logo, the agent's name, and
	// its description — instead of the generic greeting.
	$: isAgentModel = Boolean(primaryModel?.info?.base_model_id);
	$: agentBaseModel = isAgentModel
		? $_models.find((m) => m.id === primaryModel?.info?.base_model_id)
		: null;
	$: heroModel = resolveLandingHeroModel(agentBaseModel, primaryModel);
	$: agentName = isAgentModel ? primaryModel?.name ?? '' : '';
	$: agentDescription = isAgentModel ? primaryModel?.info?.meta?.description ?? '' : '';
	$: primaryModelLogoSources = getModelLogoSources(
		heroModel,
		WEBUI_API_BASE_URL,
		$i18n?.language || 'en',
		`${WEBUI_BASE_URL}/static/favicon.png`
	);
	$: primaryModelLogoWrapperClass = usesDarkLogoBadgeInLightMode(heroModel)
		? 'bg-black p-1.5 shadow-sm ring-1 ring-black/10 dark:bg-transparent dark:p-0 dark:shadow-none dark:ring-0'
		: 'bg-transparent p-0';
	$: primaryModelMotionKind = getStreamingModelLogoMotionKind(heroModel);
	$: primaryModelAtlasTier = getAtlasModelLogoMotionTier(heroModel);
	$: primaryModelMotionStyle = getStreamingModelLogoMotionStyle(
		`landing:${heroModel?.id ?? heroModel?.name ?? 'default'}`,
		primaryModelMotionKind,
		heroModel
	);
</script>

<div
	class="portico-landing-shell m-auto flex min-h-full w-full max-w-6xl flex-col justify-center px-2 pt-8 pb-24 text-center @2xl:px-20 {$showSidebar
		? ''
		: 'md:-translate-x-[1.625rem]'}"
	data-portico-rail-compensated={$showSidebar ? 'false' : 'true'}
>
	{#if $temporaryChatEnabled}
		<Tooltip
			content={$i18n.t("This chat won't appear in history and your messages will not be saved.")}
			className="w-full flex justify-center mb-0.5"
			placement="top"
		>
			<div class="flex items-center gap-2 text-gray-500 text-base my-2 w-fit">
				<EyeSlash strokeWidth="2.5" className="size-4" />{$i18n.t('Temporary Chat')}
			</div>
		</Tooltip>
	{/if}

	<div
		class="w-full text-3xl text-gray-800 dark:text-gray-100 text-center flex items-center gap-4 font-primary"
	>
		<div class="w-full flex flex-col justify-center items-center">
			{#if $selectedFolder}
				<FolderTitle
					folder={$selectedFolder}
					onUpdate={async (folder) => {
						await refreshChatListPageOne(localStorage.token);
					}}
					onDelete={async () => {
						await refreshChatListPageOne(localStorage.token);

						selectedFolder.set(null);
					}}
				/>
			{:else}
				<div
					class="portico-landing-hero {isAgentModel ? 'portico-landing-hero--agent' : ''}"
					in:fade={{ duration: 140 }}
				>
					<div class="portico-landing-hero-row">
						<div
							class={`portico-landing-hero-mark assistant-model-logo-motion assistant-model-logo-motion--${primaryModelMotionKind} is-streaming`.trim()}
							style={primaryModelMotionStyle}
							data-model-logo-motion={primaryModelMotionKind}
							data-atlas-motion-tier={primaryModelAtlasTier}
							data-model-logo-ambient="true"
							aria-hidden="true"
						>
							<div class="assistant-model-logo-rotor">
								<div class="assistant-model-logo-badge rounded-full {primaryModelLogoWrapperClass}">
									{#if primaryModelMotionKind === 'atlas'}
										<AnimatedAtlasLogo className="size-full" tier={primaryModelAtlasTier} />
									{:else if primaryModelMotionKind === 'terra'}
										<AnimatedTerraLogo
											className="size-full"
											clipId="animated-terra-landing-clip"
										/>
									{:else if primaryModelLogoSources.dark}
										<img
											src={primaryModelLogoSources.light}
											alt=""
											class="dark:hidden {usesCelestialModelLogo(heroModel) ? 'celestial-model-logo' : ''}"
											draggable="false"
										/>
										<img
											src={primaryModelLogoSources.dark ?? primaryModelLogoSources.light}
											alt=""
											class="hidden dark:block {usesCelestialModelLogo(heroModel) ? 'celestial-model-logo' : ''}"
											draggable="false"
										/>
									{:else}
										<img
											src={primaryModelLogoSources.light}
											alt=""
											class={usesCelestialModelLogo(heroModel) ? 'celestial-model-logo' : ''}
											draggable="false"
										/>
									{/if}
								</div>
							</div>
						</div>
						{#if isAgentModel}
							<div class="portico-landing-agent-name">{agentName}</div>
						{:else}
							<h1>What should we work on today?</h1>
						{/if}
					</div>
					{#if isAgentModel && agentDescription}
						<p class="portico-landing-agent-desc">{agentDescription}</p>
					{/if}
				</div>
			{/if}

			<!-- Full shell width (matches the suggested-prompt cards row) so the
		     capability row fits workspace badge + reviewer pill + model capsule
		     + metrics on ONE line. -->
		<div class="text-base font-normal w-full py-3 {atSelectedModel ? 'mt-2' : ''}">
				<MessageInput
					bind:this={messageInput}
					{chatId}
					{history}
					bind:selectedModels
					bind:files
					bind:prompt
					bind:autoScroll
					bind:selectedToolIds
					bind:selectedFilterIds
					bind:imageGenerationEnabled
					bind:codeInterpreterEnabled
					bind:webSearchEnabled
					bind:atSelectedModel
					bind:showCommands
					{reasoningEffortByModel}
					{reasoningEffortReady}
					{onReasoningEffortSelect}
					{fastModeEnabled}
					{onFastModeToggle}
					{reviewerWorkflowEnabled}
					{reviewerWorkflowLocked}
					{onReviewerWorkflowToggle}
					{reviewerWorkflowIntroVisible}
					{reviewerWorkflowIntroRemaining}
					{onReviewerWorkflowIntroDismiss}
					{ensureChatId}
					{toolServers}
					{stopResponse}
					{createMessagePair}
					placeholder={$i18n.t('How can I help you today?')}
					{onChange}
					{onUpload}
					on:submit={(e) => {
						dispatch('submit', e.detail);
					}}
				/>
			</div>
		</div>
	</div>

	{#if $selectedFolder}
		<div
			class="mx-auto px-4 md:max-w-3xl md:px-6 font-primary min-h-62"
			in:fade={{ duration: 200, delay: 200 }}
		>
			<FolderPlaceholder folder={$selectedFolder} />
		</div>
	{:else}
		<div class="mx-auto mt-3 w-full max-w-6xl font-primary" in:fade={{ duration: 200, delay: 200 }}>
			<div class="px-2.5">
				<Suggestions
					suggestionPrompts={atSelectedModel?.info?.meta?.suggestion_prompts ??
						models[selectedModelIdx]?.info?.meta?.suggestion_prompts ??
						$config?.default_prompt_suggestions ??
						[]}
					inputValue={prompt}
					{onSelect}
				/>
			</div>
		</div>
	{/if}
</div>
