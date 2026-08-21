<script lang="ts">
	import { onMount } from 'svelte';

	import Check from '$lib/components/icons/Check.svelte';
	import ChevronDown from '$lib/components/icons/ChevronDown.svelte';
	import Search from '$lib/components/icons/Search.svelte';
	import { skillInitials, cleanSkillName } from '$lib/utils/skillInitials';
	import { orderCapabilityOptionsForOpen } from '$lib/utils/capabilityPickerOrder';

	type CapabilityOption = {
		id: string;
		display_name: string;
		description?: string;
		icon_url?: string;
		source?: string;
		is_core?: boolean;
		user_installed?: boolean;
		deployment_type?: string;
	};

	export let id = 'capability-picker';
	export let label = 'Capabilities';
	export let placeholder = 'Add capabilities';
	export let searchPlaceholder = 'Search...';
	export let loadingMessage = 'Loading capabilities...';
	export let emptyMessage = 'No matches';
	export let unavailableMessage = 'No options available';
	export let emptyDescription = 'Allow this task to use connected services';
	export let selectedDescription = 'Click to review or change access';
	export let pickerTitle = 'Choose capabilities';
	export let pickerDescription = 'Pre-approved for unattended task runs';
	export let iconKind: 'skill' | 'mcp' = 'skill';
	export let options: CapabilityOption[] = [];
	export let selectedIds: string[] = [];
	export let loading = false;

	let open = false;
	let searchValue = '';
	let activeFilter = 'all';
	// Selection AS OF the popover open: the selected-first row order is frozen
	// on it, so toggles/Select all/Clear while open never reshuffle rows under
	// the pointer; the next open re-floats the then-current selection.
	let selectionAtOpen: string[] = [];
	// Ids whose icon_url failed to load — render the letter fallback instead
	// (see below: an option renders EITHER the logo OR the initial, never both,
	// so a transparent logo can't reveal the letter behind it).
	let failedIcons = new Set<string>();
	let focusTimer: ReturnType<typeof setTimeout> | undefined;
	let rootElement: HTMLElement;
	let popoverPlacement: 'up' | 'down' = 'up';
	let popoverHeight = 440;
	let popoverTop = 16;
	let popoverLeft = 16;
	let popoverWidth = 0;

	const uniqueIds = (values: string[]) =>
		Array.from(new Set((values ?? []).map((value) => `${value}`.trim()).filter(Boolean)));

	const displayNameFromId = (value: string) =>
		value
			.replace(/^server:/, '')
			.split(/[-/_]+/)
			.filter(Boolean)
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ') || value;

	const fallbackOption = (capabilityId: string): CapabilityOption => ({
		id: capabilityId,
		display_name: displayNameFromId(capabilityId),
		description: capabilityId
	});

	// Human-friendly name: skills get the clean last-segment name (matching the
	// agents-side picker); MCP servers keep their display name.
	const optionName = (option: CapabilityOption) =>
		iconKind === 'skill' ? cleanSkillName(option.display_name) : option.display_name;

	// Skills fall back to two-letter initials; MCP servers use a generic "M"
	// (matches the agents-side icon_initial). Only shown when the logo is absent.
	const optionInitial = (option: CapabilityOption) =>
		iconKind === 'skill' ? skillInitials(option.display_name) : 'M';

	// Source key used for the badge + filter (skills: system/user/marketplace;
	// MCP: host wins, then core, then user).
	const sourceKey = (option: CapabilityOption): string => {
		if (iconKind === 'skill') return `${option.source || ''}`.toLowerCase();
		const deployment = `${option.deployment_type || ''}`.toLowerCase();
		if (deployment === 'host') return 'host';
		if (option.is_core) return 'core';
		if (option.user_installed) return 'user';
		return '';
	};

	const BADGE: Record<string, { cls: string; label: string }> = {
		system: { cls: 'cap-badge-core', label: 'CORE' },
		core: { cls: 'cap-badge-core', label: 'CORE' },
		user: { cls: 'cap-badge-user', label: 'USER' },
		marketplace: { cls: 'cap-badge-marketplace', label: 'MARKETPLACE' },
		host: { cls: 'cap-badge-host', label: 'HOST' }
	};

	const FILTERS: Record<'skill' | 'mcp', { key: string; label: string }[]> = {
		skill: [
			{ key: 'all', label: 'All' },
			{ key: 'system', label: 'Core' },
			{ key: 'user', label: 'User' },
			{ key: 'marketplace', label: 'Marketplace' }
		],
		mcp: [
			{ key: 'all', label: 'All' },
			{ key: 'core', label: 'Core' },
			{ key: 'user', label: 'User' },
			{ key: 'host', label: 'Host' }
		]
	};

	const matchesSearch = (option: CapabilityOption, query: string) =>
		[option.id, optionName(option), option.description, option.source]
			.filter(Boolean)
			.some((value) => `${value}`.toLowerCase().includes(query));

	const toggleOption = (optionId: string) => {
		selectedIds = selectedIds.includes(optionId)
			? selectedIds.filter((selectedId) => selectedId !== optionId)
			: uniqueIds([...selectedIds, optionId]);
	};

	const clearSelection = () => {
		selectedIds = [];
	};

	const selectAllVisible = () => {
		selectedIds = uniqueIds([...selectedIds, ...filteredOptions.map((option) => option.id)]);
	};

	const handleIconError = (optionId: string) => {
		if (failedIcons.has(optionId)) return;
		failedIcons = new Set(failedIcons).add(optionId);
	};

	const hasIcon = (option: CapabilityOption) =>
		Boolean(option.icon_url) && !failedIcons.has(option.id);

	const placePopover = () => {
		if (!open || !rootElement) return;
		const rect = rootElement.getBoundingClientRect();
		const viewportWidth = Math.max(320, window.innerWidth);
		const viewportHeight = Math.max(320, window.innerHeight);
		const modalRect = rootElement.closest('.scheduled-task-modal')?.getBoundingClientRect();
		const viewportInset = 16;
		const modalInset = 12;
		const gap = 8;
		const topLimit = Math.max(
			viewportInset,
			modalRect ? modalRect.top + modalInset : viewportInset
		);
		const bottomLimit = Math.min(
			viewportHeight - viewportInset,
			modalRect ? modalRect.bottom - modalInset : viewportHeight - viewportInset
		);
		const above = Math.max(0, rect.top - gap - topLimit);
		const below = Math.max(0, bottomLimit - rect.bottom - gap);
		const openUp = above >= 330 || above > below;
		const available = openUp ? above : below;
		popoverPlacement = openUp ? 'up' : 'down';
		popoverHeight = Math.min(440, Math.max(240, available));
		popoverWidth = Math.min(rect.width, viewportWidth - viewportInset * 2);
		popoverLeft = Math.min(
			Math.max(viewportInset, rect.left),
			viewportWidth - popoverWidth - viewportInset
		);
		popoverTop = openUp
			? Math.max(topLimit, rect.top - gap - popoverHeight)
			: Math.min(bottomLimit - popoverHeight, rect.bottom + gap);
	};

	const setOpen = (isOpen: boolean) => {
		open = isOpen;
		if (!isOpen) {
			searchValue = '';
			activeFilter = 'all';
			clearTimeout(focusTimer);
			return;
		}
		selectionAtOpen = uniqueIds(selectedIds);
		clearTimeout(focusTimer);
		focusTimer = setTimeout(() => {
			placePopover();
			document.getElementById(`${id}-search`)?.focus({ preventScroll: true });
		}, 0);
	};

	onMount(() => {
		const closeOnOutsidePointer = (event: PointerEvent) => {
			if (open && rootElement && !rootElement.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener('pointerdown', closeOnOutsidePointer);
		window.addEventListener('resize', placePopover);
		document.addEventListener('scroll', placePopover, true);
		return () => {
			clearTimeout(focusTimer);
			document.removeEventListener('pointerdown', closeOnOutsidePointer);
			window.removeEventListener('resize', placePopover);
			document.removeEventListener('scroll', placePopover, true);
		};
	});

	$: filters = FILTERS[iconKind];
	$: optionMap = new Map(options.map((option) => [option.id, option]));
	$: selectedOptions = selectedIds.map((selectedId) => optionMap.get(selectedId) ?? fallbackOption(selectedId));
	$: allOptions = Array.from(
		new Map(
			[...options, ...selectedOptions]
				.filter((option) => Boolean(option.id))
				.map((option) => [option.id, option] as const)
		).values()
	).sort((left, right) => optionName(left).localeCompare(optionName(right)));
	// Selected-first, frozen on the at-open selection (an async catalog swap
	// mid-open re-derives with the SAME frozen selection, so rows still don't
	// jump); filters/search subset the ordered list, preserving the float.
	$: orderedOptions = orderCapabilityOptionsForOpen(allOptions, selectionAtOpen);
	$: normalizedSearchValue = searchValue.trim().toLowerCase();
	$: filteredOptions = orderedOptions.filter((option) => {
		if (activeFilter !== 'all' && sourceKey(option) !== activeFilter) return false;
		if (!normalizedSearchValue) return true;
		return matchesSearch(option, normalizedSearchValue);
	});
	$: selectedPreviewOptions = selectedOptions.slice(0, 3);
	$: selectedSummary =
		selectedOptions
			.slice(0, 2)
			.map((option) => optionName(option))
			.join(', ') + (selectedOptions.length > 2 ? ` +${selectedOptions.length - 2}` : '');
</script>

<div
	bind:this={rootElement}
	class="capability-picker"
	data-capability-picker={iconKind}
	on:keydown={(event) => {
		if (open && event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			document.getElementById(`${id}-trigger`)?.focus();
		}
	}}
>
	<div class="cap-header">
		<span class="cap-label">{label}</span>
	</div>

	<button
		type="button"
		id={`${id}-trigger`}
		class="cap-toggle"
		aria-label={`${label}: ${selectedIds.length} selected`}
		aria-haspopup="dialog"
		aria-expanded={open}
		on:click={() => setOpen(!open)}
	>
		{#if selectedOptions.length === 0}
			<span class="cap-summary-main">
				<span class="cap-summary-add" aria-hidden="true">+</span>
				<span class="cap-summary-copy">
					<span class="cap-summary-title">{placeholder}</span>
					<span class="cap-summary-description">{emptyDescription}</span>
				</span>
			</span>
		{:else}
			<span class="cap-summary-main">
				<span class="cap-summary-icons" aria-hidden="true">
					{#each selectedPreviewOptions as option (option.id)}
					<span class="cap-summary-icon cap-icon-{iconKind}">
						{#if hasIcon(option)}
							<img src={option.icon_url} alt="" loading="eager" decoding="async" on:error={() => handleIconError(option.id)} />
						{:else}
							{optionInitial(option)}
						{/if}
					</span>
					{/each}
				</span>
				<span class="cap-summary-copy">
					<span class="cap-summary-title">{selectedSummary}</span>
					<span class="cap-summary-description">{selectedDescription}</span>
				</span>
			</span>
		{/if}
		<span class="cap-count">{selectedIds.length} selected</span>
		<ChevronDown className="cap-toggle-chevron size-3 shrink-0 {open ? 'rotate-180' : ''}" strokeWidth="2.5" />
	</button>

	{#if open}
		<div
			class="cap-popover cap-popover-{popoverPlacement}"
			style={`height: ${popoverHeight}px; width: ${popoverWidth}px; left: ${popoverLeft}px; top: ${popoverTop}px;`}
			role="dialog"
			aria-label={`${label} picker`}
		>
			<div class="cap-popover-header">
				<span class="cap-popover-heading">
					<strong>{pickerTitle}</strong>
					<small>{pickerDescription}</small>
				</span>
				<button type="button" class="cap-done" on:click={() => setOpen(false)}>Done</button>
			</div>

			<div class="cap-popover-controls">
				<label class="cap-search-row">
					<Search className="size-4" strokeWidth="2.5" />
					<input
						id={`${id}-search`}
						bind:value={searchValue}
						class="cap-search"
						placeholder={searchPlaceholder}
						autocomplete="off"
						aria-label={searchPlaceholder}
					/>
				</label>

				<div class="cap-control-row">
					<div class="cap-filters" role="tablist">
						{#each filters as filter (filter.key)}
							<button
								type="button"
								class="cap-filter {activeFilter === filter.key ? 'active' : ''}"
								on:click={(event) => {
									event.preventDefault();
									event.stopPropagation();
									activeFilter = filter.key;
								}}>{filter.label}</button
							>
						{/each}
					</div>

					<div class="cap-actions">
					<button
						type="button"
						class="cap-action"
						on:click={(event) => {
							event.preventDefault();
							event.stopPropagation();
							selectAllVisible();
						}}>Select all</button
					>
						<button
							type="button"
							class="cap-action"
							on:click={(event) => {
								event.preventDefault();
								event.stopPropagation();
								clearSelection();
							}}>Clear</button
						>
					</div>
				</div>
			</div>

			<div class="cap-list" role="listbox" aria-label={label} aria-multiselectable="true">
				{#if loading}
					<div class="cap-empty-row">{loadingMessage}</div>
				{:else if filteredOptions.length > 0}
					{#each filteredOptions as option (option.id)}
						{@const isSelected = selectedIds.includes(option.id)}
						{@const badge = BADGE[sourceKey(option)]}
						<button
							type="button"
							class="cap-row {isSelected ? 'is-selected' : ''}"
							role="option"
							aria-selected={isSelected}
							data-capability-option={option.id}
							data-capability-selected={isSelected ? 'true' : 'false'}
							on:click={() => toggleOption(option.id)}
						>
							<span class="cap-row-icon cap-icon-{iconKind}" aria-hidden="true">
								{#if hasIcon(option)}
									<img src={option.icon_url} alt="" loading="eager" decoding="async" on:error={() => handleIconError(option.id)} />
								{:else}
									{optionInitial(option)}
								{/if}
							</span>
							<span class="cap-row-main">
								<span class="cap-row-name">{optionName(option)}</span>
								{#if badge}
									<span class="cap-badge {badge.cls}">{badge.label}</span>
								{/if}
							</span>
							<span class="cap-row-check" aria-hidden="true">
								{#if isSelected}
									<Check className="size-3.5" strokeWidth="2.5" />
								{/if}
							</span>
						</button>
					{/each}
				{:else}
					<div class="cap-empty-row">
						{normalizedSearchValue || activeFilter !== 'all' ? emptyMessage : unavailableMessage}
					</div>
				{/if}
			</div>

			<div class="cap-popover-footer">
				<span><strong>{selectedIds.length} selected</strong> · changes apply immediately</span>
				<button type="button" class="cap-done" on:click={() => setOpen(false)}>Done</button>
			</div>
		</div>
	{/if}
</div>
