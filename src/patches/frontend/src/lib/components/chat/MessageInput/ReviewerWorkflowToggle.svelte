<script lang="ts">
	// PORTICO_PATCH (reviewer workflow): standalone critic pill. Armed only
	// before the chat's first prompt; afterwards it locks read-only, showing
	// whether the workflow was activated for this chat (and its children).
	// The pinned CTA callout renders below the pill on the landing composer.
	import Tooltip from '$lib/components/common/Tooltip.svelte';

	export let enabled = false;
	export let locked = false;
	export let showIntro = false;
	export let introRemaining = 0;
	export let onToggle: Function = () => {};
	export let onDismissIntro: Function = () => {};

	// Tooltip copy matches the intro popover verbatim (PM ask, 2026-08-14):
	// same heading + body as the "AI Reviews are now live!" callout below.
	$: tooltipContent = locked
		? `<div class="fast-mode-tooltip">
		<div class="fast-mode-tooltip-title">
			<span>🤝🏼 AI Reviews are now live!<em>${enabled ? 'on' : 'off'}</em></span>
		</div>
		<div class="fast-mode-tooltip-body">${
			enabled
				? 'This chat runs automatic polymodel review &amp; critique.'
				: 'This chat runs without the reviewer workflow.'
		} Decided by the first message — locked for this chat and its children.</div>
	</div>`
		: `<div class="fast-mode-tooltip">
		<div class="fast-mode-tooltip-title">
			<span>🤝🏼 AI Reviews are now live!${enabled ? '<em>on</em>' : ''}</span>
		</div>
		<div class="fast-mode-tooltip-body">Use the power of multiple different models to review your request. Responses may take longer.</div>
		<div class="fast-mode-tooltip-hint">Click to turn ${enabled ? 'off' : 'on'}</div>
	</div>`;
</script>

<div class="reviewer-workflow-wrapper relative flex h-full items-stretch">
	{#if showIntro}
		<div class="reviewer-workflow-intro" role="status">
			<div class="reviewer-workflow-intro-sheen" aria-hidden="true"></div>
			<button
				type="button"
				class="reviewer-workflow-intro-close"
				aria-label="Dismiss"
				on:click|stopPropagation={() => onDismissIntro()}
			>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round"
					class="size-3"
					aria-hidden="true"
				>
					<path d="M6 6l12 12M18 6L6 18" />
				</svg>
			</button>
			<div class="reviewer-workflow-intro-title">🤝🏼 AI Reviews are now live!</div>
			<div class="reviewer-workflow-intro-body">
				Use the power of multiple different models to review your request. Responses may take
				longer.
			</div>
			<div class="reviewer-workflow-intro-footer">
				This will display {introRemaining} more {introRemaining === 1 ? 'time' : 'times'}.
			</div>
			<div class="reviewer-workflow-intro-arrow" aria-hidden="true"></div>
		</div>
	{/if}
	<Tooltip
		content={showIntro ? '' : tooltipContent}
		placement="top"
		className="flex h-full items-stretch"
	>
		<button
			type="button"
			id="reviewer-workflow-toggle-button"
			class="reviewer-workflow-toggle capability-pill shrink-0 whitespace-nowrap outline-none focus:outline-none {locked
				? 'cursor-default'
				: 'capability-pill--interactive cursor-pointer'}"
			data-reviewer-workflow={enabled ? 'true' : 'false'}
			data-reviewer-workflow-locked={locked ? 'true' : 'false'}
			aria-pressed={enabled}
			aria-disabled={locked}
			aria-label={locked
				? `AI Reviews ${enabled ? 'on' : 'off'} — locked for this chat`
				: enabled
					? 'AI Reviews on — multiple models review your request'
					: 'AI Reviews — multiple models review your request'}
			on:click={() => {
				if (!locked) onToggle(!enabled);
			}}
		>
			<!-- clipboard-check: the reviewer's sign-off -->
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="size-3.5"
				aria-hidden="true"
			>
				<rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
				<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
				<path d="m9 14 2 2 4-4" />
			</svg>
		</button>
	</Tooltip>
</div>

<style>
	/* Enabled: filled amber pill — a color fill reads clearly on the light
	   theme where a tinted glyph alone washes out. */
	.reviewer-workflow-toggle[data-reviewer-workflow='true'] {
		background: #fef3c7;
		border-color: #f59e0b;
		color: #b45309;
	}
	:global(.dark) .reviewer-workflow-toggle[data-reviewer-workflow='true'] {
		background: rgba(252, 211, 77, 0.14);
		border-color: rgba(252, 211, 77, 0.55);
		color: #fcd34d;
	}

	/* Pinned intro callout: sleek dark glassy tooltip centered ABOVE the pill.
	   One dark design for both themes (the modern tooltip idiom, and the only
	   surface a white sheen sweep actually reads on). pointer-events: none
	   keeps the pill clickable straight through the callout. */
	.reviewer-workflow-intro {
		position: absolute;
		bottom: calc(100% + 14px);
		left: 50%;
		transform: translateX(-50%);
		width: max-content;
		max-width: 22rem;
		padding: 0.85rem 1.1rem;
		border-radius: 0.9rem;
		border: 1px solid rgba(255, 255, 255, 0.14);
		background: linear-gradient(180deg, #283548 0%, #131c2b 100%);
		box-shadow:
			0 18px 42px -12px rgba(2, 6, 23, 0.55),
			inset 0 1px 0 rgba(255, 255, 255, 0.12);
		pointer-events: none;
		text-align: left;
		z-index: 60;
	}
	/* Glassy glisten: a bright skewed band sweeps left → right across the dark
	   surface (clipped layer, composited transform only). White over the dark
	   gradient reads clearly — the previous cream-on-cream version did not. */
	.reviewer-workflow-intro-sheen {
		position: absolute;
		inset: 0;
		border-radius: inherit;
		overflow: hidden;
		pointer-events: none;
	}
	.reviewer-workflow-intro-sheen::after {
		content: '';
		position: absolute;
		top: -30%;
		bottom: -30%;
		left: 0;
		width: 40%;
		background: linear-gradient(
			100deg,
			transparent 0%,
			rgba(255, 255, 255, 0.06) 30%,
			rgba(255, 255, 255, 0.3) 50%,
			rgba(255, 255, 255, 0.06) 70%,
			transparent 100%
		);
		transform: translateX(-160%) skewX(-16deg);
		animation: reviewer-intro-sheen 3.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
	}
	@keyframes reviewer-intro-sheen {
		0% {
			transform: translateX(-160%) skewX(-16deg);
		}
		60%,
		100% {
			transform: translateX(400%) skewX(-16deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.reviewer-workflow-intro-sheen::after {
			animation: none;
			opacity: 0;
		}
	}

	.reviewer-workflow-intro-title {
		position: relative;
		font-size: 0.9rem;
		font-weight: 700;
		line-height: 1.3;
		color: #ffffff;
		letter-spacing: 0.01em;
	}
	.reviewer-workflow-intro-body {
		position: relative;
		margin-top: 0.5rem;
		font-size: 0.8125rem;
		line-height: 1.45;
		color: rgba(226, 232, 240, 0.85);
		padding-right: 0.75rem;
	}
	/* The bubble is pointer-events: none so the pill stays clickable through
	   it — the X re-enables events for itself only. */
	.reviewer-workflow-intro-close {
		position: absolute;
		top: 0.45rem;
		right: 0.45rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 9999px;
		color: rgba(226, 232, 240, 0.6);
		background: transparent;
		pointer-events: auto;
		cursor: pointer;
		transition:
			color 120ms ease,
			background-color 120ms ease;
		z-index: 1;
	}
	.reviewer-workflow-intro-close:hover {
		color: #ffffff;
		background: rgba(255, 255, 255, 0.12);
	}
	:global(.dark) .reviewer-workflow-intro-close {
		color: rgba(71, 85, 105, 0.65);
	}
	:global(.dark) .reviewer-workflow-intro-close:hover {
		color: #0f172a;
		background: rgba(15, 23, 42, 0.08);
	}
	.reviewer-workflow-intro-footer {
		position: relative;
		margin-top: 0.55rem;
		font-size: 0.68rem;
		letter-spacing: 0.01em;
		color: rgba(226, 232, 240, 0.5);
	}
	:global(.dark) .reviewer-workflow-intro-footer {
		color: rgba(71, 85, 105, 0.6);
	}
	/* Dark theme: invert to a WHITE glassy bubble so the callout stands out
	   against the dark canvas the same way the dark bubble does on light. */
	:global(.dark) .reviewer-workflow-intro {
		/* Silver-slate base (toned so the bright sheen has luminance headroom)
		   + a soft luminous halo: a dark drop shadow is invisible on the dark
		   canvas, so the "aura" here is emitted light, not cast shadow. */
		background: linear-gradient(180deg, #f8fafc 0%, #d7dee8 100%);
		border-color: rgba(203, 213, 225, 0.7);
		box-shadow:
			0 0 44px rgba(203, 213, 225, 0.32),
			0 0 12px rgba(226, 232, 240, 0.28),
			0 18px 42px -12px rgba(0, 0, 0, 0.6),
			inset 0 1px 0 rgba(255, 255, 255, 0.95);
	}
	:global(.dark) .reviewer-workflow-intro-title {
		color: #0f172a;
	}
	:global(.dark) .reviewer-workflow-intro-body {
		color: rgba(51, 65, 85, 0.9);
	}
	:global(.dark) .reviewer-workflow-intro-arrow {
		border-top-color: #d7dee8;
		filter: drop-shadow(0 2px 4px rgba(203, 213, 225, 0.35));
	}
	/* Sheen on the white bubble: a bright specular core with faint cool
	   glass-tint edges — gloss on light surfaces is a BRIGHTER band, never a
	   gray one. */
	:global(.dark) .reviewer-workflow-intro-sheen::after {
		background: linear-gradient(
			100deg,
			transparent 0%,
			rgba(165, 180, 252, 0.18) 30%,
			rgba(255, 255, 255, 0.95) 50%,
			rgba(125, 211, 252, 0.18) 70%,
			transparent 100%
		);
	}
	.reviewer-workflow-intro-arrow {
		position: absolute;
		top: 100%;
		left: 50%;
		margin-left: -7px;
		border: 7px solid transparent;
		border-top-color: #131c2b;
		filter: drop-shadow(0 1px 0 rgba(255, 255, 255, 0.08));
	}
</style>
