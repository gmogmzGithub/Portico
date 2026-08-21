<script lang="ts">
	import Bolt from '$lib/components/icons/Bolt.svelte';
	import SuggestionIcon from './SuggestionIcon.svelte';
	import { getContext } from 'svelte';
	import { settings, WEBUI_NAME } from '$lib/stores';
	import { WEBUI_VERSION } from '$lib/constants';
	import { resolveSuggestionVisualKind } from '$lib/utils/suggestionVisual';

	const i18n = getContext('i18n');

	export let suggestionPrompts = [];
	export let className = '';
	export let inputValue = '';
	export let onSelect = (e) => {};

	let sortedPrompts = [];
	let visiblePrompts = [];

	const getSuggestionLabel = (prompt, visualKind) => {
		const labels = {
			welcome: 'Discover what Portico can do',
			integrations: 'Connect and enable new integrations',
			meetings: "Review this week's key meetings",
			portico: "Catch up on this week's Portico news"
		};

		if (labels[visualKind]) {
			return labels[visualKind];
		}

		const configuredLabel =
			prompt.title && prompt.title[0] !== ''
				? prompt.title.filter(Boolean).join(' ')
				: prompt.content;

		return configuredLabel.replace(/(?:\.{3}|…)/g, '').replace(/\s+/g, ' ').trim();
	};

	$: if (suggestionPrompts) {
		sortedPrompts = [...(suggestionPrompts ?? [])];
	}

	$: visiblePrompts = sortedPrompts.slice(0, 4);
</script>

<div class="portico-suggestions-heading mb-3 flex items-center gap-1 font-medium text-gray-600 dark:text-gray-400">
	{#if visiblePrompts.length > 0}
		<Bolt />
		{$i18n.t('Suggested')}
	{:else}
		<div
			class="flex w-full {$settings?.landingPageMode === 'chat'
				? ' -mt-1'
				: 'text-center items-center justify-center'}  self-start text-gray-600 dark:text-gray-400"
		>
			{$WEBUI_NAME} ‧ v{WEBUI_VERSION}
		</div>
	{/if}
</div>

<div class="portico-suggestions-container w-full">
	{#if visiblePrompts.length > 0}
		<div role="list" class="portico-suggestions-grid {className}">
			{#each visiblePrompts as prompt, idx (prompt.id || `${prompt.content}-${idx}`)}
				{@const visualKind = resolveSuggestionVisualKind(prompt)}
				<!-- svelte-ignore a11y-no-interactive-element-to-noninteractive-role -->
				<button
					role="listitem"
					class="portico-suggestion-card waterfall group"
					style="animation-delay: {idx * 60}ms"
					on:click={() => onSelect({ type: 'prompt', data: prompt.content })}
					data-suggestion-card={visualKind}
				>
					<div
						class="portico-suggestion-card-content"
						data-suggestion-card-content
					>
						<SuggestionIcon kind={visualKind} />
						<div class="portico-suggestion-copy min-w-0">
							<div
								class="line-clamp-3 font-medium leading-snug text-gray-900 transition dark:text-gray-100"
							>
								{getSuggestionLabel(prompt, visualKind)}
							</div>
						</div>
					</div>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.portico-suggestions-container {
		container-name: portico-suggestions;
		container-type: inline-size;
	}

	.portico-suggestions-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.85rem;
		align-items: stretch;
	}

	.portico-suggestion-card {
		position: relative;
		display: flex;
		width: 100%;
		min-height: 6.5rem;
		overflow: hidden;
		padding: 1rem;
		border: 1px solid rgba(15, 23, 42, 0.1);
		border-radius: 1.45rem;
		background: rgba(255, 255, 255, 0.84);
		color: inherit;
		text-align: left;
		box-shadow:
			0 1px 2px rgba(15, 23, 42, 0.055),
			0 12px 34px -24px rgba(15, 23, 42, 0.26);
		transition:
			transform 160ms ease,
			border-color 160ms ease,
			box-shadow 160ms ease,
			background-color 160ms ease;
	}

	.portico-suggestion-card:hover {
		transform: translateY(-2px);
		border-color: rgba(15, 23, 42, 0.15);
		background: rgba(255, 255, 255, 0.96);
		box-shadow:
			0 2px 4px rgba(15, 23, 42, 0.065),
			0 18px 42px -25px rgba(15, 23, 42, 0.32);
	}

	.portico-suggestion-card:focus-visible {
		outline: 2px solid rgba(0, 91, 211, 0.72);
		outline-offset: 3px;
	}

	.portico-suggestion-card-content {
		display: flex;
		width: 100%;
		min-width: 0;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.9rem;
	}

	.portico-suggestion-copy {
		width: 100%;
		min-height: 2.5rem;
		margin-top: auto;
	}

	:global(.dark) .portico-suggestion-card {
		border-color: var(--portico-dark-card-border, rgba(255, 255, 255, 0.14));
		background: var(--portico-dark-card-surface, #222225);
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.55),
			0 16px 36px -24px rgba(0, 0, 0, 0.95);
	}

	:global(.dark) .portico-suggestion-card:hover {
		border-color: var(--portico-dark-card-border-hover, rgba(255, 255, 255, 0.21));
		background: var(--portico-dark-card-hover, #2b2b2f);
		box-shadow:
			0 2px 4px rgba(0, 0, 0, 0.5),
			0 20px 46px -24px rgba(0, 0, 0, 0.88);
	}

	@container portico-suggestions (min-width: 38rem) {
		.portico-suggestions-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@container portico-suggestions (min-width: 60rem) {
		.portico-suggestions-grid {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}

	/* Waterfall animation for the suggestions */
	@keyframes fadeInUp {
		0% {
			opacity: 0;
			transform: translateY(20px);
		}
		100% {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.waterfall {
		opacity: 0;
		animation-name: fadeInUp;
		animation-duration: 200ms;
		animation-fill-mode: forwards;
		animation-timing-function: ease;
	}

	@media (prefers-reduced-motion: reduce) {
		.waterfall {
			opacity: 1;
			animation: none;
		}

		.portico-suggestion-card {
			transition: none;
		}
	}
</style>
