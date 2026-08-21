<script lang="ts">
	import Tooltip from '$lib/components/common/Tooltip.svelte';

	export let enabled = true;
	export let content: any = '';
	export let placement = 'top';
	export let className = '';
	export let elementId: string | undefined = undefined;
	export let tippyOptions: Record<string, any> | undefined = undefined;
</script>

{#if enabled}
	<Tooltip {content} {placement} {className} {elementId} {tippyOptions} {...$$restProps}>
		<slot />
		<slot name="tooltip" slot="tooltip" />
	</Tooltip>
{:else}
	<slot />
{/if}
