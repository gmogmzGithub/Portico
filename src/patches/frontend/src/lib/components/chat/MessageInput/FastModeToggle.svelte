<script lang="ts">
	import Tooltip from '$lib/components/common/Tooltip.svelte';

	export let enabled = false;
	export let onToggle: Function = () => {};

	$: tooltipContent = `<div class="fast-mode-tooltip">
		<div class="fast-mode-tooltip-title">
			<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.2 2.5 5.4 13.1h5.5l-1 8.4 8.7-12h-5.8l.4-7Z" /></svg>
			<span>Fast mode${enabled ? '<em>on</em>' : ''}</span>
		</div>
		<div class="fast-mode-tooltip-body">Priority processing for GPT models — noticeably faster responses for this chat while enabled. Uses premium per-token pricing.</div>
		<div class="fast-mode-tooltip-hint">Click to turn ${enabled ? 'off' : 'on'}</div>
	</div>`;
</script>

<Tooltip content={tooltipContent} placement="top" className="flex h-full items-stretch">
	<button
		type="button"
		id="fast-mode-toggle-button"
		class="fast-mode-toggle capability-pill capability-pill--interactive shrink-0 cursor-pointer whitespace-nowrap outline-none focus:outline-none"
		data-fast-mode={enabled ? 'true' : 'false'}
		aria-pressed={enabled}
		aria-label={enabled ? 'Fast mode on — priority processing for GPT models' : 'Fast mode — priority processing for GPT models'}
		on:click={() => onToggle(!enabled)}
	>
		<span class="fast-mode-toggle-bolt" aria-hidden="true">
			<svg viewBox="0 0 24 24" fill="currentColor" class="size-3.5">
				<path d="M13.2 2.5 5.4 13.1h5.5l-1 8.4 8.7-12h-5.8l.4-7Z" />
			</svg>
		</span>
	</button>
</Tooltip>
