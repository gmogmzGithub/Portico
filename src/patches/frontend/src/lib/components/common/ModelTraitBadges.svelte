<script lang="ts">
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import ModelTraitGlyph from '$lib/components/common/ModelTraitGlyph.svelte';
	import {
		MODEL_TRAIT_DEFINITIONS,
		type ModelTraitKey
	} from '$lib/config/model-traits';

export let traits: ModelTraitKey[] = [];
export let className = '';
export let iconClassName = 'size-4.5';
export let badgeClassName = '';
export let showTooltips = true;
export let placement = 'top';
</script>

{#if traits.length > 0}
	<div class={`flex items-center gap-1.5 ${className}`.trim()}>
		{#each traits as trait, index (`${trait}-${index}`)}
			{@const definition = MODEL_TRAIT_DEFINITIONS[trait]}

			{#if showTooltips}
				<Tooltip content={definition.description} {placement}>
					<div class={`model-trait-badge inline-flex size-6 items-center justify-center rounded-full bg-slate-200/95 text-slate-700 dark:bg-gray-800/90 dark:text-gray-200 ${badgeClassName}`.trim()}>
						<ModelTraitGlyph {trait} className={iconClassName} />
					</div>
				</Tooltip>
			{:else}
				<div class={`model-trait-badge inline-flex size-6 items-center justify-center rounded-full bg-slate-200/95 text-slate-700 dark:bg-gray-800/90 dark:text-gray-200 ${badgeClassName}`.trim()}>
					<ModelTraitGlyph {trait} className={iconClassName} />
				</div>
			{/if}
		{/each}
	</div>
{/if}
