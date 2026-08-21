<!--
	PORTICO PATCH (Round 4 / Issue 7b): amber "needs attention" dot for
	scheduled-task rows in the sidebar.

	Renders a small amber circle when the parent passes
	``needsAttention=true``. The circle has a tooltip carrying the
	human-readable ``reason`` so the user knows what went wrong without
	opening the chat.

	The component is purely presentational. The data lifecycle
	(``ScheduledTask.needs_attention`` is set by the daemon when a run
	terminates with auth_required / missing_integration / failed /
	missed, and cleared either by a successful run OR by an explicit
	``clear_needs_attention`` call from the chat-open hook) lives in
	the Rust scheduling-server (see
	docs/architecture/scheduled-task-runtime.md "Attention flag").

	The host component (``ChatItem.svelte`` for individual rows;
	``FolderItem.svelte`` for the folder-level rollup) is responsible
	for fetching the scheduled-task metadata and passing
	``needsAttention`` + ``reason`` down. Keeping this component
	host-agnostic lets us reuse the same dot for chat-row + folder-
	rollup placement without duplicating the styling.

	Cross-references:
	- src/core-mcp-rust/crates/scheduling-server/src/model.rs (data)
	- src/core-mcp-rust/crates/scheduling-server/src/storage.rs (clear
	  helper)
	- docs/architecture/scheduled-task-runtime.md "Attention flag"
-->
<script lang="ts">
	export let needsAttention: boolean = false;
	export let reason: string | null = null;
	export let count: number | null = null;

	$: tooltipText = renderTooltip(reason, count);

	function renderTooltip(currentReason: string | null, currentCount: number | null): string {
		if (currentCount && currentCount > 1) {
			return `${currentCount} scheduled tasks need your attention`;
		}
		switch (currentReason) {
			case 'auth_required':
				return 'Re-authenticate the integration to resume runs.';
			case 'missing_integration':
				return 'A required integration is offline or uninstalled.';
			case 'run_failed':
				return 'The most recent run failed; open the chat to investigate.';
			case 'missed_run':
				return 'A scheduled run was missed because the daemon was offline at the time.';
			case 'out_of_scope_chip_pending':
			case 'awaiting_confirmation':
				return 'A sub-agent is waiting on your approval to continue.';
			case 'awaiting_clarification':
				return 'A sub-agent is asking you to clarify before it continues.';
			default:
				return 'This task needs your attention.';
		}
	}
</script>

{#if needsAttention}
	<span
		class="task-attention-dot inline-block size-2 shrink-0 rounded-full bg-amber-500 ring-2 ring-amber-200/40 dark:ring-amber-500/20"
		title={tooltipText}
		aria-label={tooltipText}
		role="img"
		data-test-id="task-attention-dot"
		data-attention-reason={reason ?? 'unknown'}
		data-attention-count={count ?? 1}
	></span>
{/if}
