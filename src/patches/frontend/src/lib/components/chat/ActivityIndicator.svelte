<script>
	import { onDestroy } from 'svelte';
	import {
		formatElapsedDuration,
		normalizeStreamStartedAt
	} from '$lib/utils/streaming-activity.mjs';

	export let isActive = false;
	export let messageId = '';
	export let startedAt = Date.now();

	let now = Date.now();
	let activityTimer = null;

	const clearActivityTimer = () => {
		if (activityTimer) {
			clearInterval(activityTimer);
			activityTimer = null;
		}
	};

	$: normalizedStartedAt = normalizeStreamStartedAt(startedAt);
	$: elapsedDuration = formatElapsedDuration((now - normalizedStartedAt) / 1000);

	$: if (isActive && !activityTimer) {
		now = Date.now();
		activityTimer = setInterval(() => {
			now = Date.now();
		}, 1000);
	} else if (!isActive && activityTimer) {
		clearActivityTimer();
	}

	onDestroy(() => {
		clearActivityTimer();
	});
</script>

{#if isActive}
	<div
		class="pt-3 pb-1"
		data-testid="streaming-activity-indicator"
		data-message-id={messageId || undefined}
	>
		<span class="activity-text text-sm font-medium">
			Working for {elapsedDuration}
		</span>
	</div>
{/if}

<style>
	.activity-text {
		--activity-shimmer-rest: #475569;
		--activity-shimmer-mid: #64748b;
		--activity-shimmer-peak: #245fd4;

		color: var(--activity-shimmer-rest);
		animation: activity-text-shimmer 4s ease-in-out infinite;
	}

	:global(.dark) .activity-text {
		--activity-shimmer-rest: #f8fbff;
		--activity-shimmer-mid: #d3e3ff;
		--activity-shimmer-peak: var(--portico-accent-text, #4f94ff);
	}

	@keyframes activity-text-shimmer {
		0% {
			color: var(--activity-shimmer-rest);
			text-shadow: none;
		}
		35% {
			color: var(--activity-shimmer-mid);
			text-shadow: none;
		}
		50% {
			color: var(--activity-shimmer-peak);
			text-shadow: 0 0 14px rgba(79, 148, 255, 0.34);
		}
		65% {
			color: var(--activity-shimmer-mid);
			text-shadow: none;
		}
		100% {
			color: var(--activity-shimmer-rest);
			text-shadow: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.activity-text {
			animation: none;
		}
	}
</style>
