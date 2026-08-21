<script lang="ts">
	import { getContext } from 'svelte';

	import ModelTraitBadges from '$lib/components/common/ModelTraitBadges.svelte';
	import {
		MODEL_TRAIT_DEFINITIONS,
		MODEL_TRAIT_LEGEND_ORDER
	} from '$lib/config/model-traits';

	const i18n = getContext('i18n');

	export let showTooltips = true;
	export let stacked = false;
	export let compact = false;
	export let concise = false;
	export let className = '';

	const compactDescriptions = {
		general: 'Balanced for everyday work.',
		heavy: 'For complex, slower work.',
		premium: 'Maximum capability for the hardest work.',
		lightweight: 'Fast for simple tasks.'
	};
</script>

<aside
	class="model-selector-guide h-fit {compact ? 'model-selector-guide-compact' : ''} {stacked
		? 'model-selector-guide-stacked border-t border-slate-300/70 pt-3 dark:border-gray-800'
		: 'sticky top-0 border-l border-slate-300/70 pl-3 dark:border-gray-800'} {className}"
	aria-label={$i18n.t('Model Guide')}
>
	<div
		class="px-0.5 pb-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-gray-400"
	>
		{$i18n.t('Model Guide')}
	</div>

	<div class="model-selector-guide-list">
		{#each MODEL_TRAIT_LEGEND_ORDER as traitKey}
			{@const definition = MODEL_TRAIT_DEFINITIONS[traitKey]}
			<div
				class="model-selector-guide-item border-t border-slate-300/60 px-0.5 py-2.5 first:border-t-0 dark:border-gray-800"
			>
				<div class="flex items-center gap-2">
					<ModelTraitBadges
						traits={[traitKey]}
						className="shrink-0"
						iconClassName="size-4"
						{showTooltips}
					/>
					<div class="text-sm font-medium text-slate-900 dark:text-gray-100">
						{definition.label}
					</div>
				</div>
				<div class="mt-1 text-xs leading-relaxed text-slate-500 dark:text-gray-400">
					{compact || concise ? compactDescriptions[traitKey] : definition.description}
				</div>
			</div>
		{/each}
	</div>
</aside>

<style>
	.model-selector-guide-compact .model-selector-guide-list {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
	}

	.model-selector-guide-compact .model-selector-guide-item {
		padding: 0.42rem 0.6rem;
		border-top: 0;
		border-left: 1px solid var(--portico-divider-subtle);
	}

	.model-selector-guide-compact .model-selector-guide-item :global(.text-xs) {
		line-height: 1.25;
	}

	.model-selector-guide-compact .model-selector-guide-item:first-child {
		border-left: 0;
	}

	@media (max-width: 640px) {
		.model-selector-guide-compact .model-selector-guide-list {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.model-selector-guide-compact .model-selector-guide-item:nth-child(3) {
			border-left: 0;
		}
	}
</style>
