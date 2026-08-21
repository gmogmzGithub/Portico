<script lang="ts">
	import { getContext } from 'svelte';
	import { DropdownMenu } from 'bits-ui';
	import ChevronDown from '$lib/components/icons/ChevronDown.svelte';
	import { flyAndScale } from '$lib/utils/transitions';
	import { resolveReasoningEffortByModelEntry } from '$lib/utils/chatReasoningState';

	const i18n = getContext('i18n');

	export let model;
	export let modelCount = 1;
	export let reasoningEffortByModel: Record<string, string> = {};
	export let readOnlyMode = false;
	export let standalone = false;
	export let includeDefault = false;
	export let disabled = false;
	export let disabledLabel = '';
	export let onSelect: Function = () => {};

	const allOptions = [
		{ value: 'none', label: 'None' },
		{ value: 'low', label: 'Low' },
		{ value: 'medium', label: 'Medium' },
		{ value: 'high', label: 'High' },
		{ value: 'xhigh', label: 'Extra High' },
		{ value: 'max', label: 'Max' },
		{ value: 'ultra', label: 'Ultra' }
	];

	$: modelOptions = model.options ?? [];
	$: availableOptions = [
		...(includeDefault ? [{ value: '', label: $i18n.t('Default') }] : []),
		...allOptions.filter((option) => modelOptions.includes(option.value))
	];
	$: explicitEffort = reasoningEffortByModel?.[String(model.index)]?.trim() ?? '';
	$: currentEffort =
		includeDefault && !explicitEffort
			? ''
			: resolveReasoningEffortByModelEntry({
					reasoningEffortByModel,
					modelIndex: model.index,
					allowedOptions: modelOptions
				}) ?? modelOptions[0];
	$: currentIndex = Math.max(
		0,
		availableOptions.findIndex((option) => option.value === currentEffort)
	);
	$: currentOption = availableOptions[currentIndex] ?? availableOptions[0];
	$: currentLabel = disabled && disabledLabel ? disabledLabel : currentOption?.label ?? currentEffort;
	$: sliderMax = Math.max(availableOptions.length - 1, 0);
	$: sliderProgress = sliderMax > 0 ? (currentIndex / sliderMax) * 100 : 100;
	$: isMaximumEffort = !disabled && availableOptions.length > 0 && currentIndex === sliderMax;
	$: particleSpeedSeconds = sliderMax > 0 ? 1.45 - (currentIndex / sliderMax) * 0.83 : 0.62;
	$: tooltipLabel =
		modelCount > 1
			? model.baseModelName
				? `${model.name} (${model.baseModelName}) - Reasoning`
				: `${model.name} - Reasoning Effort`
			: model.baseModelName
				? `Reasoning Effort (${model.baseModelName})`
				: $i18n.t('Reasoning Effort');

	const selectIndex = (index: number) => {
		const option = availableOptions[index];
		if (!option || option.value === currentEffort) return;
		onSelect({ modelIndex: model.index, value: option.value });
	};
</script>

<div
	class="reasoning-effort-control-inner"
	class:reasoning-effort-control--standalone={standalone}
	class:reasoning-effort-control--disabled={disabled}
>
	{#if readOnlyMode}
		<div
			id="reasoning-effort-button-{model.index}"
			class="reasoning-effort-trigger capability-pill shrink-0 whitespace-nowrap select-none"
			data-effort-max={isMaximumEffort ? 'true' : 'false'}
			title={tooltipLabel}
		>
			<svg viewBox="0 0 24 24" fill="currentColor" class="size-3.5" aria-hidden="true">
				<path d="M13.2 2.5 5.4 13.1h5.5l-1 8.4 8.7-12h-5.8l.4-7Z" />
			</svg>
			<span>{currentLabel}</span>
		</div>
	{:else}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				type="button"
				id="reasoning-effort-button-{model.index}"
				class="reasoning-effort-trigger capability-pill shrink-0 whitespace-nowrap outline-none focus:outline-none {disabled
					? 'cursor-not-allowed'
					: 'capability-pill--interactive cursor-pointer'}"
				disabled={disabled}
				data-effort-max={isMaximumEffort ? 'true' : 'false'}
				aria-label={tooltipLabel}
				title={tooltipLabel}
			>
				<svg viewBox="0 0 24 24" fill="currentColor" class="size-3.5" aria-hidden="true">
					<path d="M13.2 2.5 5.4 13.1h5.5l-1 8.4 8.7-12h-5.8l.4-7Z" />
				</svg>
				<span>{currentLabel}</span>
				<ChevronDown className="size-3 shrink-0" strokeWidth="2.5" />
			</DropdownMenu.Trigger>

			<DropdownMenu.Content
					class="portico-menu-surface reasoning-effort-popover"
					data-effort-max={isMaximumEffort ? 'true' : 'false'}
					side="top"
					align="center"
					sideOffset={12}
					collisionPadding={12}
					transition={flyAndScale}
				>
					<div class="reasoning-effort-popover-heading">
						<div>
							<div class="reasoning-effort-popover-kicker">Reasoning effort</div>
							<div class="reasoning-effort-popover-value">{currentLabel}</div>
						</div>
						<svg viewBox="0 0 24 24" fill="currentColor" class="reasoning-effort-popover-bolt" aria-hidden="true">
							<path d="M13.2 2.5 5.4 13.1h5.5l-1 8.4 8.7-12h-5.8l.4-7Z" />
						</svg>
					</div>

					<div
						class="reasoning-effort-slider-shell"
						data-effort-max={isMaximumEffort ? 'true' : 'false'}
						style={`--effort-progress: ${sliderProgress}%; --effort-particle-speed: ${particleSpeedSeconds.toFixed(2)}s;`}
					>
						<div class="reasoning-effort-slider-track" aria-hidden="true">
							<div class="reasoning-effort-slider-fill">
								<span></span><span></span><span></span><span></span><span></span><span></span><span></span>
							</div>
						</div>
						<input
							class="reasoning-effort-slider"
							type="range"
							min="0"
							max={sliderMax}
							step="1"
							value={currentIndex}
							aria-label={tooltipLabel}
							aria-valuetext={currentLabel}
							on:input={(event) => selectIndex(Number((event.currentTarget as HTMLInputElement).value))}
						/>
					</div>

					<div class="reasoning-effort-slider-labels" aria-hidden="true">
						<span>Faster</span>
						<span>Smarter</span>
					</div>
			</DropdownMenu.Content>
			</DropdownMenu.Root>
	{/if}
</div>
