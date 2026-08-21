<script lang="ts">
	import { onMount } from 'svelte';
	import {
		activeSkillBadges,
		activeSkillRowLabel,
		activeSkillSourceRank
	} from '$lib/utils/activeSkillBadges';
	import type { ChatCapabilities } from '$lib/apis/chatCapabilities';

	export let capabilities: ChatCapabilities = { tools: [], skills: [] };
	export let costLabel = '$0.00';
	export let costWithoutCacheLabel = '$0.00';
	export let cacheSavingsLabel = '$0.00';
	export let cacheSavingsTone: 'positive' | 'negative' | 'neutral' = 'neutral';
	export let savingsRateLabel = '0%';
	export let cacheReadsLabel = '0';
	export let cacheWritesLabel = '0';
	export let contextTokensLabel = '0';
	export let maxContextTokensLabel = '0';
	export let contextPercent = 0;
	export let contextPercentLabel = '0';
	export let remainingContextTokensLabel = '0';

	$: sortedTools = [...(capabilities?.tools ?? [])].sort((a, b) => {
		if (a.is_core !== b.is_core) return a.is_core ? -1 : 1;
		return a.display_name.localeCompare(b.display_name);
	});
	$: sortedSkills = [...(capabilities?.skills ?? [])]
		.map((skill) => ({
			...skill,
			rowLabel: activeSkillRowLabel(skill),
			badges: activeSkillBadges(skill)
		}))
		.sort(
			(a, b) =>
				activeSkillSourceRank(a) - activeSkillSourceRank(b) ||
				a.rowLabel.localeCompare(b.rowLabel)
		);
	$: activeCount = sortedTools.length + sortedSkills.length;
	$: hasTools = sortedTools.length > 0;
	$: hasSkills = sortedSkills.length > 0;
	$: normalizedContextPercent = Math.max(0, Math.min(100, Number(contextPercent) || 0));

	let controlElement: HTMLDivElement;
	let popoverElement: HTMLDivElement;
	let placementFrame: number | null = null;
	let open = false;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;

	const CLOSE_DELAY_MS = 120;

	const positionPopover = () => {
		placementFrame = null;
		if (!controlElement || !popoverElement) return;

		const rect = controlElement.getBoundingClientRect();
		const popRect = popoverElement.getBoundingClientRect();
		const margin = 12;
		let left = rect.left + rect.width / 2 - popRect.width / 2;
		left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));

		popoverElement.style.left = `${left}px`;
		popoverElement.style.bottom = `${window.innerHeight - rect.top + 12}px`;
	};

	const schedulePopoverPlacement = () => {
		if (placementFrame !== null) cancelAnimationFrame(placementFrame);
		placementFrame = requestAnimationFrame(positionPopover);
	};

	const handleEscapeKeydown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') closePopover();
	};

	// Attached only while the popover is open so the hot window resize/scroll
	// paths carry no listeners for the (common) closed state.
	const attachWhileOpenListeners = () => {
		window.addEventListener('resize', schedulePopoverPlacement);
		window.visualViewport?.addEventListener('resize', schedulePopoverPlacement);
		window.addEventListener('scroll', schedulePopoverPlacement, { capture: true, passive: true });
		window.addEventListener('keydown', handleEscapeKeydown);
	};

	const detachWhileOpenListeners = () => {
		window.removeEventListener('resize', schedulePopoverPlacement);
		window.visualViewport?.removeEventListener('resize', schedulePopoverPlacement);
		window.removeEventListener('scroll', schedulePopoverPlacement, { capture: true });
		window.removeEventListener('keydown', handleEscapeKeydown);
	};

	const cancelScheduledClose = () => {
		if (closeTimer !== null) {
			clearTimeout(closeTimer);
			closeTimer = null;
		}
	};

	const openPopover = () => {
		cancelScheduledClose();
		if (open) return;
		open = true;
		// The popover node is portaled to document.body, outside this
		// component's DOM tree; toggle its class imperatively.
		popoverElement?.classList.add('composer-metrics-popover--open');
		schedulePopoverPlacement();
		attachWhileOpenListeners();
	};

	const closePopover = () => {
		cancelScheduledClose();
		if (!open) return;
		open = false;
		popoverElement?.classList.remove('composer-metrics-popover--open');
		detachWhileOpenListeners();
	};

	const scheduleClose = () => {
		cancelScheduledClose();
		closeTimer = setTimeout(() => {
			closeTimer = null;
			closePopover();
		}, CLOSE_DELAY_MS);
	};

	const handleControlFocusOut = (event: FocusEvent) => {
		const next = event.relatedTarget;
		if (next instanceof Node && (controlElement?.contains(next) || popoverElement?.contains(next))) {
			return;
		}
		scheduleClose();
	};

	onMount(() => {
		// Portal the popover to <body> so it cannot be clipped or painted over
		// by ancestor stacking contexts (e.g. the backdrop-filter on
		// #message-input-container).
		document.body.appendChild(popoverElement);

		const resizeObserver = new ResizeObserver(schedulePopoverPlacement);
		resizeObserver.observe(controlElement);
		resizeObserver.observe(popoverElement);

		controlElement.addEventListener('mouseenter', openPopover);
		controlElement.addEventListener('focusin', openPopover);
		controlElement.addEventListener('mouseleave', scheduleClose);
		controlElement.addEventListener('focusout', handleControlFocusOut);
		popoverElement.addEventListener('mouseenter', cancelScheduledClose);
		popoverElement.addEventListener('mouseleave', scheduleClose);

		return () => {
			resizeObserver.disconnect();
			cancelScheduledClose();
			detachWhileOpenListeners();
			controlElement?.removeEventListener('mouseenter', openPopover);
			controlElement?.removeEventListener('focusin', openPopover);
			controlElement?.removeEventListener('mouseleave', scheduleClose);
			controlElement?.removeEventListener('focusout', handleControlFocusOut);
			popoverElement?.removeEventListener('mouseenter', cancelScheduledClose);
			popoverElement?.removeEventListener('mouseleave', scheduleClose);
			if (placementFrame !== null) cancelAnimationFrame(placementFrame);
			// Svelte teardown only removes nodes it still owns in-tree; the
			// portaled popover lives under document.body and must be removed
			// explicitly.
			popoverElement?.remove();
		};
	});
</script>

<div
	bind:this={controlElement}
	class="composer-metrics-control group relative shrink-0 whitespace-nowrap"
>
	<button
		type="button"
		class="composer-metrics-trigger composer-rail-control-surface capability-pill capability-pill--readonly"
		aria-label={`${contextPercentLabel}% context used, ${costLabel} spent, ${activeCount} active capabilities`}
		aria-describedby="composer-metrics-tooltip"
	>
		<svg class="composer-metrics-ring" viewBox="0 0 36 36" aria-hidden="true">
			<circle class="composer-metrics-ring-track" cx="18" cy="18" r="14" />
			<circle
				class:composer-metrics-ring-warning={normalizedContextPercent >= 50 && normalizedContextPercent < 80}
				class:composer-metrics-ring-critical={normalizedContextPercent >= 80}
				class="composer-metrics-ring-value"
				cx="18"
				cy="18"
				r="14"
				stroke-dasharray={`${normalizedContextPercent * 0.88} 88`}
			/>
		</svg>
		<span>{contextPercentLabel}%</span>
		<span class="composer-metrics-trigger-divider" aria-hidden="true"></span>
		<span>{costLabel}</span>
	</button>

	<div
		bind:this={popoverElement}
		id="composer-metrics-tooltip"
		class="composer-metrics-popover"
		role="tooltip"
	>
		<div class="composer-metrics-popover-header">
			<div>
				<div class="composer-metrics-popover-kicker">Chat details</div>
				<div class="composer-metrics-popover-title">Usage and connected capabilities</div>
			</div>
			<span class="composer-metrics-active-count">{activeCount} active</span>
		</div>

		<!-- Row 1: Active MCPs | Context usage | Spend and cache. Row 2: Active
		     skills full width (skill labels carry plugin prefixes and their
		     provenance chips, so the row earns the whole popover width). -->
		<div
			class="composer-metrics-popover-grid"
			class:composer-metrics-popover-grid--no-tools={!hasTools}
		>
			{#if hasTools}
				<section class="composer-metrics-section">
					<div class="composer-metrics-section-title">Active MCPs</div>
					<div class="composer-metrics-capability-list">
						{#each sortedTools as tool (tool.server_id)}
							<div class="composer-metrics-capability-item" title={tool.display_name}>
								<div class="composer-metrics-capability-icon">
									{#if tool.icon_url}
										<img src={tool.icon_url} alt="" />
									{:else}
										<span>{tool.display_name.charAt(0)}</span>
									{/if}
								</div>
								<span class="composer-metrics-capability-name">{tool.display_name}</span>
								{#if tool.is_core}
									<span class="composer-metrics-capability-meta">Core</span>
								{:else if tool.tool_count}
									<span class="composer-metrics-capability-meta">{tool.tool_count} tools</span>
								{/if}
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<section class="composer-metrics-section">
				<div class="composer-metrics-section-title">Context usage</div>
				<div class="composer-metrics-context-summary">
					<svg class="composer-metrics-context-ring" viewBox="0 0 36 36" aria-hidden="true">
						<circle class="composer-metrics-ring-track" cx="18" cy="18" r="14" />
						<circle
							class:composer-metrics-ring-warning={normalizedContextPercent >= 50 && normalizedContextPercent < 80}
							class:composer-metrics-ring-critical={normalizedContextPercent >= 80}
							class="composer-metrics-ring-value"
							cx="18"
							cy="18"
							r="14"
							stroke-dasharray={`${normalizedContextPercent * 0.88} 88`}
						/>
					</svg>
					<div><strong>{contextPercentLabel}%</strong><span>of context used</span></div>
				</div>
				<dl class="composer-metrics-detail-list">
					<div><dt>Context</dt><dd>{contextTokensLabel}</dd></div>
					<div><dt>Window</dt><dd>{maxContextTokensLabel}</dd></div>
					<div><dt>Usage</dt><dd>{contextPercentLabel}%</dd></div>
					<div><dt>Left</dt><dd>{remainingContextTokensLabel}</dd></div>
				</dl>
			</section>

			<section class="composer-metrics-section">
				<div class="composer-metrics-section-title">Spend and cache</div>
				<dl class="composer-metrics-detail-list">
					<div><dt>Chat total</dt><dd>{costLabel}</dd></div>
					<div><dt>Without cache</dt><dd>{costWithoutCacheLabel}</dd></div>
					<div><dt>Net savings</dt><dd data-tone={cacheSavingsTone}>{cacheSavingsLabel}</dd></div>
					<div><dt>Savings rate</dt><dd data-tone={cacheSavingsTone}>{savingsRateLabel}</dd></div>
					<div><dt>Cache reads</dt><dd>{cacheReadsLabel}</dd></div>
					<div><dt>Cache writes</dt><dd>{cacheWritesLabel}</dd></div>
				</dl>
			</section>

			{#if hasSkills}
				<section class="composer-metrics-section composer-metrics-section--skills">
					<div class="composer-metrics-section-title">Active skills</div>
					<div class="composer-metrics-skill-grid">
						{#each sortedSkills as skill (skill.name)}
							<div class="composer-metrics-skill-name" title={skill.rowLabel}>
								{skill.rowLabel}
							</div>
							<div class="composer-metrics-skill-chips">
								{#each skill.badges as badge (badge.kind)}
									<span
										class="composer-skill-badge composer-skill-badge--{badge.kind}"
										title={badge.kind === 'marketplace-name' ? badge.label : undefined}
										>{badge.label}</span
									>
								{/each}
							</div>
						{/each}
					</div>
				</section>
			{/if}
		</div>
	</div>
</div>
