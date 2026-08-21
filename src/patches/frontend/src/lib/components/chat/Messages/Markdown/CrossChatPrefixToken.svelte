<script lang="ts">
	// Badge-row rendering of a cross-chat provenance prefix: "Message from"
	// + sender display-name badge (click copies the chat id; tooltip shows it)
	// + sending model/agent avatar + model-name chip. The raw UUID and the
	// "from Model X" prose never render.
	import { getContext } from 'svelte';
	import { models } from '$lib/stores';
	import { WEBUI_API_BASE_URL, WEBUI_BASE_URL } from '$lib/constants';
	import { copyToClipboard } from '$lib/utils';
	import { badgeStyleVars } from '$lib/utils/displayNameBadge.mjs';
	import {
		getModelLogoSources,
		usesCelestialModelLogo,
		usesDarkLogoBadgeInLightMode
	} from '$lib/utils/modelBranding';
	import Tooltip from '$lib/components/common/Tooltip.svelte';

	const i18n: any = getContext('i18n');

	export let token: {
		chatId: string;
		displayName: string;
		modelName: string;
		modelId: string;
		isAgent: boolean;
	};

	let copied = false;
	let copiedResetTimeout: ReturnType<typeof setTimeout> | null = null;

	const copyChatId = async () => {
		const ok = await copyToClipboard(token.chatId);
		if (!ok) return;
		copied = true;
		// One-shot feedback reset on explicit user click — not recurring work.
		if (copiedResetTimeout) clearTimeout(copiedResetTimeout);
		copiedResetTimeout = setTimeout(() => {
			copied = false;
			copiedResetTimeout = null;
		}, 1200);
	};

	// Same brand-logo resolution as message avatars/model selector; a
	// synthetic candidate keeps brand logos working when the model no longer
	// exists in the catalog (family derives from the name).
	$: senderModel =
		($models ?? []).find((item) => item?.id === token.modelId) ??
		($models ?? []).find((item) => item?.name === token.modelName) ??
		null;
	$: logoCandidate = senderModel ?? { id: token.modelId, name: token.modelName };
	$: logoSources = getModelLogoSources(
		logoCandidate,
		WEBUI_API_BASE_URL,
		$i18n?.language || 'en',
		`${WEBUI_BASE_URL}/static/favicon.png`
	);
</script>

<span class="cross-chat-prefix inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 align-middle">
	<span class="text-sm text-slate-500 dark:text-slate-400">Message from</span>

	<Tooltip content={token.chatId} placement="top">
		<button
			type="button"
			class="display-name-badge inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold leading-4 transition hover:brightness-95 dark:hover:brightness-125"
			style={badgeStyleVars(token.displayName)}
			aria-label={`Copy chat id ${token.chatId}`}
			on:click|stopPropagation={copyChatId}
		>
			<span class="max-w-40 truncate">{token.displayName}</span>
			{#if copied}
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" class="size-3 shrink-0" aria-hidden="true">
					<path d="M3 8.5 6.5 12 13 4.5" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
			{:else}
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="size-3 shrink-0 opacity-70" aria-hidden="true">
					<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
					<path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5" />
				</svg>
			{/if}
		</button>
	</Tooltip>

	{#if token.modelName}
		<span
			class="inline-flex shrink-0 items-center justify-center rounded-full {usesDarkLogoBadgeInLightMode(
				logoCandidate
			)
				? 'bg-black p-[1.5px] shadow-sm ring-1 ring-black/10 dark:bg-transparent dark:ring-0'
				: ''}"
			aria-hidden="true"
		>
			{#if logoSources.dark}
				<img
					src={logoSources.light}
					alt=""
					class="size-4 rounded-full object-contain dark:hidden {usesCelestialModelLogo(logoCandidate)
						? 'celestial-model-logo'
						: ''}"
					loading="lazy"
				/>
				<img
					src={logoSources.dark}
					alt=""
					class="hidden size-4 rounded-full object-contain dark:block {usesCelestialModelLogo(
						logoCandidate
					)
						? 'celestial-model-logo'
						: ''}"
					loading="lazy"
				/>
			{:else}
				<img
					src={logoSources.light}
					alt=""
					class="size-4 rounded-full object-contain {usesCelestialModelLogo(logoCandidate)
						? 'celestial-model-logo'
						: ''}"
					loading="lazy"
				/>
			{/if}
		</span>
		<span
			class="inline-flex items-center rounded-full border border-slate-300/80 bg-slate-100 px-2 py-0.5 text-xs font-medium leading-4 text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
		>
			{token.modelName}
		</span>
	{/if}
</span>

<style>
	.display-name-badge {
		background: var(--badge-bg);
		color: var(--badge-text);
		border-color: var(--badge-border);
	}
	:global(.dark) .display-name-badge {
		background: var(--badge-bg-dark);
		color: var(--badge-text-dark);
		border-color: var(--badge-border-dark);
	}
</style>
