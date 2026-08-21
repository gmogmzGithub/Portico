<script context="module" lang="ts">
	const WORK_ACTIVITY_SPOTLIGHT_DURATION_MS = 2400;
	const MAX_TRACKED_SHIMMERS = 256;
	type ShimmerState = { label: string; startedAt: number; lastSeenAt: number };
	type ShimmerParams = { active: boolean; animationKey: string; label: string };

	// This registry intentionally lives at module scope. Streaming reconciliation can
	// replace a summary component, but it must not replace that summary's timeline.
	const shimmerStates = new Map<string, ShimmerState>();

	const rememberShimmer = (animationKey: string, label: string) => {
		const now = Date.now();
		const key = animationKey || label;
		const previous = shimmerStates.get(key);
		const state =
			previous?.label === label
				? { ...previous, lastSeenAt: now }
				: { label, startedAt: now, lastSeenAt: now };
		shimmerStates.set(key, state);

		if (shimmerStates.size > MAX_TRACKED_SHIMMERS) {
			const oldestKey = [...shimmerStates.entries()].sort(
				([, left], [, right]) => left.lastSeenAt - right.lastSeenAt
			)[0]?.[0];
			if (oldestKey) shimmerStates.delete(oldestKey);
		}

		return state;
	};
</script>

<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	export let summary: {
		hasActivity: boolean;
		isActive: boolean;
		kind: 'none' | 'reasoning' | 'tool' | 'completed';
		label: string;
	};
	export let expanded = false;
	export let controlsId = '';
	export let first = false;

	const dispatch = createEventDispatcher<{ toggle: { expanded: boolean } }>();

	// Streaming token updates can reconcile or briefly remount a summary. Keep a
	// stable phase for the same message segment and label so those updates never
	// restart the spotlight. A real label change deliberately begins a new pass.
	const maintainShimmerPhase = (node: HTMLElement, params: ShimmerParams) => {
		let current = params;

		const applyPhase = (next: ShimmerParams, restartForLabelChange = false) => {
			current = next;
			if (!next.active) {
				node.style.removeProperty('--work-activity-spotlight-delay');
				return;
			}

			const state = rememberShimmer(next.animationKey, next.label);
			const elapsed = Math.max(0, Date.now() - state.startedAt);
			node.style.setProperty(
				'--work-activity-spotlight-delay',
				`-${elapsed % WORK_ACTIVITY_SPOTLIGHT_DURATION_MS}ms`
			);

			if (restartForLabelChange) {
				node.style.animation = 'none';
				void node.offsetWidth;
				node.style.animation = '';
			}
		};

		applyPhase(params);

		return {
			update(next: ShimmerParams) {
				const labelChanged = next.label !== current.label;
				const identityChanged = next.animationKey !== current.animationKey;
				if (labelChanged || identityChanged || next.active !== current.active) {
					applyPhase(next, labelChanged);
				}
			}
		};
	};
</script>

{#if summary?.hasActivity}
	<button
		type="button"
		class="work-activity-summary group flex min-h-9 w-fit max-w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-slate-400 transition-colors hover:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/45 dark:text-slate-500 dark:hover:text-slate-400"
		class:work-activity-summary--active={summary.isActive}
		class:work-activity-summary--first={first}
		aria-expanded={expanded}
		aria-controls={controlsId || undefined}
		on:click={() => {
			expanded = !expanded;
			dispatch('toggle', { expanded });
		}}
	>
		<span class="work-activity-summary__icon grid size-6 shrink-0 place-items-center" aria-hidden="true">
			{#if summary.kind === 'reasoning'}
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="size-[18px]">
					<path stroke-linecap="round" stroke-linejoin="round" d="M9.5 4.25a3 3 0 0 1 5 2.23 3.25 3.25 0 0 1 2.9 4.76 3 3 0 0 1-1.9 5.51A3.5 3.5 0 0 1 12 20a3.5 3.5 0 0 1-3.5-3.25 3 3 0 0 1-1.9-5.51 3.25 3.25 0 0 1 2.9-4.76 3 3 0 0 1 0-2.23Z" />
					<path stroke-linecap="round" d="M12 6v12" />
				</svg>
			{:else if summary.kind === 'tool'}
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="size-[18px]">
					<rect x="3.5" y="4.5" width="17" height="15" rx="3" />
					<path stroke-linecap="round" stroke-linejoin="round" d="m7.5 9 2.5 2.5L7.5 14M12.5 14h4" />
				</svg>
			{:else}
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="size-[18px]">
					<path stroke-linecap="round" stroke-linejoin="round" d="m14.7 5.3 4 4M4 20l3.6-.8L19.2 7.6a1.4 1.4 0 0 0 0-2l-.8-.8a1.4 1.4 0 0 0-2 0L4.8 16.4 4 20Z" />
				</svg>
			{/if}
		</span>

		<span
			class="work-activity-summary__label min-w-0 truncate"
			class:work-activity-summary__label--active={summary.isActive}
			use:maintainShimmerPhase={{
				active: summary.isActive,
				animationKey: controlsId,
				label: summary.label
			}}
		>
			{summary.label}
		</span>

		<svg
			viewBox="0 0 20 20"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			class="size-4 shrink-0 transition-transform duration-150 {expanded ? 'rotate-90' : ''}"
			aria-hidden="true"
		>
			<path stroke-linecap="round" stroke-linejoin="round" d="m7.5 4.5 5 5-5 5" />
		</svg>
	</button>
{/if}

<style>
	.work-activity-summary {
		margin-top: 0.15rem;
		color: #475569 !important;
		font-size: inherit !important;
		font-weight: 400 !important;
		line-height: inherit;
	}

	.work-activity-summary:hover {
		color: #334155 !important;
	}

	:global(.dark) .work-activity-summary {
		color: #a9c9f5 !important;
	}

	:global(.dark) .work-activity-summary:hover {
		color: #c8ddfb !important;
	}

	.work-activity-summary--first {
		margin-top: 0.9rem;
	}

	.work-activity-summary__label {
		font-size: inherit !important;
		font-weight: 400 !important;
	}

	.work-activity-summary__label--active {
		color: transparent;
		background-image: linear-gradient(
			100deg,
			#475569 0%,
			#475569 34%,
			#1e293b 49%,
			#475569 64%,
			#475569 100%
		);
		background-size: 260% 100%;
		background-clip: text;
		-webkit-background-clip: text;
		animation: work-activity-spotlight 2.4s linear infinite;
		animation-delay: var(--work-activity-spotlight-delay, 0ms);
	}

	:global(.dark) .work-activity-summary__label--active {
		background-image: linear-gradient(
			100deg,
			#a9c9f5 0%,
			#a9c9f5 34%,
			#eff6ff 49%,
			#a9c9f5 64%,
			#a9c9f5 100%
		);
	}

	.work-activity-summary--active .work-activity-summary__icon {
		animation: work-activity-icon-breathe 1.55s ease-in-out infinite;
	}

	@keyframes work-activity-spotlight {
		from {
			background-position: 130% 50%;
		}
		to {
			background-position: -130% 50%;
		}
	}

	@keyframes work-activity-icon-breathe {
		0%,
		100% {
			opacity: 0.62;
		}
		50% {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.work-activity-summary__label--active,
		.work-activity-summary--active .work-activity-summary__icon {
			animation: none;
		}
	}
</style>
