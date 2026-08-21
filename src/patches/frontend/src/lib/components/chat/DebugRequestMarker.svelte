<script lang="ts">
	import MaybeTooltip from '$lib/components/common/MaybeTooltip.svelte';
	import type { DebugMonitorRequestSummary } from '$lib/utils/owuiDebugMonitor';

	export let request: DebugMonitorRequestSummary;
	export let onInspect: (requestId: string) => void = () => {};

	const formatUsage = (request: DebugMonitorRequestSummary) => {
		const total = request?.usage?.total_tokens;
		return typeof total === 'number' && Number.isFinite(total) ? `${total.toLocaleString()} tok` : 'pending';
	};

	$: tooltipText = [
		request?.base_model || request?.model || 'unknown',
		request?.request_phase ? `phase=${request.request_phase}` : null,
		request?.task_name ? `task=${request.task_name}` : null,
		typeof request?.followup_index === 'number' ? `followup=${request.followup_index}` : null,
		`${request?.message_count ?? 0} msgs`,
		`${request?.tool_count ?? 0} tools`,
		request?.duration_ms ? `${request.duration_ms}ms` : null,
		formatUsage(request)
	]
		.filter(Boolean)
		.join(' • ');
</script>

<div class="debug-request-marker">
	<div class="debug-request-line"></div>
	<MaybeTooltip content={tooltipText} placement="top">
		<button
			class="debug-request-button"
			type="button"
			title={tooltipText}
			on:click={() => onInspect(request.request_id)}
			aria-label="Inspect upstream request JSON"
		>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<circle cx="11" cy="11" r="7"></circle>
				<path d="m20 20-3.5-3.5"></path>
			</svg>
		</button>
	</MaybeTooltip>
</div>

<style>
	.debug-request-marker {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		margin: 0.2rem 0 0.55rem 0;
	}

	.debug-request-line {
		flex: 1;
		height: 6px;
		border-radius: 999px;
		background: linear-gradient(90deg, rgba(252, 165, 165, 0.86), rgba(254, 202, 202, 0.78));
		box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.16);
	}

	.debug-request-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: 999px;
		border: 1px solid rgba(248, 113, 113, 0.24);
		background: rgba(255, 241, 242, 0.92);
		color: #b91c1c;
		cursor: pointer;
		flex-shrink: 0;
	}

	.debug-request-button:hover {
		background: rgba(254, 226, 226, 0.98);
	}

	.debug-request-button svg {
		width: 16px;
		height: 16px;
	}

	:global(html.dark) .debug-request-button {
		background: rgba(69, 10, 10, 0.78);
		color: #fecaca;
		border-color: rgba(248, 113, 113, 0.28);
	}

	:global(html.dark) .debug-request-button:hover {
		background: rgba(127, 29, 29, 0.88);
	}
</style>
