<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import Fuse from 'fuse.js';

	import dayjs from '$lib/dayjs';
	import relativeTime from 'dayjs/plugin/relativeTime';
	dayjs.extend(relativeTime);

	import Spinner from '$lib/components/common/Spinner.svelte';
	import { flyAndScale } from '$lib/utils/transitions';
	import { onDestroy, getContext, tick } from 'svelte';

	import { deleteModel, pullModel, unloadModel } from '$lib/apis/ollama';

	import {
		user,
		MODEL_DOWNLOAD_POOL,
		models,
		mobile,
		settings,
		config
	} from '$lib/stores';
	import { toast } from 'svelte-sonner';
	import { splitStream } from '$lib/utils';
	import { getModels } from '$lib/apis';
	import { getModelItems as getWorkspaceModels } from '$lib/apis/models';
	import { resolveInitialPickerTab, orderAgentPickerItems } from '$lib/utils/modelPickerState';
	import {
		buildModelSelectorContentStyle,
		computeModelSelectorLayout
	} from '$lib/utils/modelSelectorLayout';

	import ChevronDown from '$lib/components/icons/ChevronDown.svelte';
	import Check from '$lib/components/icons/Check.svelte';
	import Search from '$lib/components/icons/Search.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import ModelTraitBadges from '$lib/components/common/ModelTraitBadges.svelte';
	import { WEBUI_API_BASE_URL, WEBUI_BASE_URL } from '$lib/constants';
	import {
		getModelTraitSortRankForModel,
		resolveModelTraitKeysForModel
	} from '$lib/config/model-traits';
	import { resolveModelPricing } from '$lib/config/model-pricing';
	import { resolveModelPickerMetadata } from '$lib/config/model-capabilities';
	import { getModelAvailability, isModelHidden } from '$lib/utils/modelAvailability';
	import {
		getCelestialModelIdentity,
		getModelLogoSources,
		getModelSelectorLogoPresentation,
		isLocalEmbeddingModelCandidate,
		isLocalModelCandidate
	} from '$lib/utils/modelBranding';

	import ModelItem from './ModelItem.svelte';
	import ModelGuide from './ModelGuide.svelte';

	const i18n = getContext('i18n');

	export let id = '';
	export let value = '';
	export let disabled = false;
	export let placeholder = $i18n.t('Select a model');
	export let searchEnabled = true;
	export let searchPlaceholder = $i18n.t('Search models and agents');

	// Picker entries include normalized base models and custom-agent wrappers whose
	// fields intentionally extend the upstream model store shape.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type Model = Record<string, any>;

	type SelectorItem = {
		label: string;
		value: string;
		model: Model;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		[key: string]: any;
	};

	export let items: SelectorItem[] = [];

	const DEFAULT_MODEL_SELECTOR_CLASS_NAME = 'w-[56rem]';
	const THREE_PROVIDER_MODEL_SELECTOR_CLASS_NAME = 'w-[68rem]';
	const FOUR_PROVIDER_MODEL_SELECTOR_CLASS_NAME = 'w-[84rem]';
	const COMPOSER_MODEL_SELECTOR_WIDTH_REM = 68;
	const MODEL_SELECTOR_VIEWPORT_PADDING_PX = 16;
	const MODEL_SELECTOR_SIDE_GUIDE_MIN_WIDTH_PX = 1040;
	const MODEL_SELECTOR_MIN_CONSTRAINED_WIDTH_PX = 320;
	const MODEL_SELECTOR_CLASS_WIDTHS_PX: Record<string, number> = {
		[DEFAULT_MODEL_SELECTOR_CLASS_NAME]: 56 * 16,
		[THREE_PROVIDER_MODEL_SELECTOR_CLASS_NAME]: 68 * 16,
		[FOUR_PROVIDER_MODEL_SELECTOR_CLASS_NAME]: 84 * 16
	};

	export let className = DEFAULT_MODEL_SELECTOR_CLASS_NAME;
	export let triggerClassName = 'text-lg';
	export let composer = false;

	export let pinModelHandler: (modelId: string) => void = () => {};
	// Fails closed: a caller has to opt in before this picker can change a
	// global default. ModelSelector.svelte derives it from the placement.
	export let showSetDefault = false;
	export let defaultModelId = '';
	export let savingDefaultModel = false;
	export let setDefaultModelHandler: (modelId: string) => Promise<void> = async () => {};
	export let showSelectedModelLogo = false;

	let tagsContainerElement;

	let show = false;
	let tags = [];
	let workspaceAgentItems: typeof items = [];
	let workspaceAgentsLoaded = false;
	let workspaceAgentsLoading = false;
	let mergedBaseSourceItems: typeof items = [];
	let baseSelectableItems: typeof items = [];
	let workspaceAgentItemIds = new Set<string>();
	let baseSelectableItemIds = new Set<string>();

	let selectedModel: SelectorItem | null = null;
	let selectedModelTraitKeys = [];
	let selectedModelLogoSources = getModelLogoSources(
		null,
		WEBUI_API_BASE_URL,
		$i18n?.language || 'en',
		`${WEBUI_BASE_URL}/static/favicon.png`
	);
	let selectedModelLogoPresentation = getModelSelectorLogoPresentation(null, 'compact');
	let allSelectableItems: typeof items = [];
	let isLoadingWorkspaceAgentSearch = false;
	let defaultModel: SelectorItem | null = null;
	let selectedModelIsDefault = false;
	let canSaveDefaultModel = false;
	$: selectedModel =
		allSelectableItems.find((item) => item.value === value) ??
		items.find((item) => item.value === value) ??
		null;
	$: defaultModel =
		allSelectableItems.find((item) => item.value === defaultModelId) ??
		items.find((item) => item.value === defaultModelId) ??
		null;
	$: selectedModelTraitKeys = resolveModelTraitKeysForModel(selectedModel?.model ?? null);
	$: selectedModelIsDefault = Boolean(value) && value === defaultModelId;
	$: selectedModelLogoSources = getModelLogoSources(
		selectedModel,
		WEBUI_API_BASE_URL,
		$i18n?.language || 'en',
		`${WEBUI_BASE_URL}/static/favicon.png`
	);
	$: selectedModelLogoPresentation = getModelSelectorLogoPresentation(selectedModel, 'compact');

	let searchValue = '';

	let selectedTag = '';
	let selectedPickerTab: 'models' | 'agents' = 'models';
	// True once the user clicks a tab in the current open; blocks the
	// post-agents-load auto-switch from overriding an explicit choice.
	let pickerTabUserOverride = false;

	let ollamaVersion = null;
	let selectedModelIdx = 0;
	let visibleItems: typeof items = [];
	let renderLimit = 0;
	let renderMoreFrame: number | null = null;
	let searchInputFocusTimer: number | null = null;
	let lastModelsRefreshAt = 0;
	let modelsRefreshInFlight = false;
	let navDragRegionElement: HTMLElement | null = null;
	let previousNavAppRegionValue = '';
	let previousNavAppRegionPriority = '';
	let navDragRegionOverrideActive = false;
	let groupedBaseModelGridClass = 'md:grid-cols-2';
	let modelSelectorContentClassName = DEFAULT_MODEL_SELECTOR_CLASS_NAME;
	let modelSelectorConstrainedWidthPx: number | null = null;
	// Composer picker always opens upward (avoidCollisions off); cap its height to
	// the space above the trigger so a tall list scrolls internally instead of
	// overflowing off the top of the viewport.
	let modelSelectorConstrainedMaxHeightPx: number | null = null;
	let modelSelectorContentStyle = '';
	let shouldStackModelGuide = false;

	const INITIAL_VISIBLE_MODELS = 24;
	const VISIBLE_MODELS_CHUNK = 24;
	const MODELS_REFRESH_COOLDOWN_MS = 60_000;

	const getNavDragRegionElement = () => {
		if (typeof document === 'undefined') {
			return null;
		}

		const triggerElement = document.getElementById(`model-selector-${id}-button`);
		return (
			(triggerElement?.closest('nav') as HTMLElement | null) ??
			(document.querySelector('nav.drag-region') as HTMLElement | null)
		);
	};

	const enableNavOutsideDismiss = () => {
		if (navDragRegionOverrideActive) {
			return;
		}

		const navElement = getNavDragRegionElement();
		if (!navElement) {
			return;
		}

		navDragRegionElement = navElement;
		previousNavAppRegionValue = navElement.style.getPropertyValue('-webkit-app-region');
		previousNavAppRegionPriority = navElement.style.getPropertyPriority('-webkit-app-region');
		navElement.style.setProperty('-webkit-app-region', 'no-drag');
		navDragRegionOverrideActive = true;
	};

	const restoreNavOutsideDismiss = () => {
		if (!navDragRegionOverrideActive || !navDragRegionElement) {
			return;
		}

		if (previousNavAppRegionValue) {
			navDragRegionElement.style.setProperty(
				'-webkit-app-region',
				previousNavAppRegionValue,
				previousNavAppRegionPriority
			);
		} else {
			navDragRegionElement.style.removeProperty('-webkit-app-region');
		}

		navDragRegionElement = null;
		previousNavAppRegionValue = '';
		previousNavAppRegionPriority = '';
		navDragRegionOverrideActive = false;
	};

	const normalizeModelId = (candidate: unknown) => {
		const normalized = `${candidate ?? ''}`.trim();
		return normalized && normalized !== 'null' && normalized !== 'undefined' ? normalized : '';
	};

	const buildNormalizedPickerModel = (model: Record<string, any> | null | undefined) => {
		const info = model?.info ?? {};
		const meta = {
			...(model?.meta ?? {}),
			...(info?.meta ?? {})
		};
		const baseModelId =
			model?.base_model_id ??
			model?.baseModelId ??
			info?.base_model_id ??
			info?.baseModelId ??
			null;

		return {
			...(model ?? {}),
			info: {
				...info,
				base_model_id: baseModelId,
				meta
			},
			meta,
			tags: model?.tags ?? []
		};
	};

	const buildWorkspaceAgentPickerItem = (model: Record<string, any> | null | undefined) => {
		const normalizedModel = buildNormalizedPickerModel(model);
		const modelId = normalizeModelId(normalizedModel?.id);
		const baseModelId = normalizeModelId(
			normalizedModel?.base_model_id ??
				normalizedModel?.baseModelId ??
				normalizedModel?.info?.base_model_id ??
				normalizedModel?.info?.baseModelId ??
				''
		);

		if (!modelId || !baseModelId) {
			return null;
		}

		return {
			label: normalizedModel?.name ?? modelId,
			value: modelId,
			model: {
				...normalizedModel,
				base_model_id: baseModelId,
				info: {
					...(normalizedModel?.info ?? {}),
					base_model_id: baseModelId
				}
			}
		};
	};

	const buildPickerItemFromModel = (
		model: Record<string, any> | null | undefined,
		existingItem: Record<string, any> | null | undefined = null
	) => {
		const normalizedModel = buildNormalizedPickerModel(model);
		const modelId = normalizeModelId(normalizedModel?.id ?? existingItem?.value ?? '');

		return {
			...(existingItem ?? {}),
			label: existingItem?.label ?? normalizedModel?.name ?? modelId,
			value: existingItem?.value ?? modelId,
			model: normalizedModel
		};
	};

	const getItemModelId = (item: { model?: Model; value?: string } | null | undefined) =>
		normalizeModelId(item?.model?.id ?? item?.value ?? '');

	const getItemIdentityKey = (item: { model?: Model; value?: string; label?: string }) =>
		normalizeModelId(item?.value ?? item?.model?.id ?? item?.label ?? '');

	const dedupeSelectableItems = (candidateItems: typeof items) => {
		const seenKeys = new Set<string>();

		return candidateItems.filter((item) => {
			const key = getItemIdentityKey(item);
			if (!key || seenKeys.has(key)) {
				return false;
			}

			seenKeys.add(key);
			return true;
		});
	};

	const fuse = new Fuse(
		allSelectableItems.map((item) => {
			const _item = {
				...item,
				modelName: item.model?.name,
				tags: (item.model?.tags ?? []).map((tag) => tag.name).join(' '),
				desc: item.model?.info?.meta?.description
			};
			return _item;
		}),
		{
			keys: ['value', 'tags', 'modelName'],
			threshold: 0.4
		}
	);

	const updateFuse = () => {
		if (fuse) {
			fuse.setCollection(
				allSelectableItems.map((item) => {
					const _item = {
						...item,
						modelName: item.model?.name,
						tags: (item.model?.tags ?? []).map((tag) => tag.name).join(' '),
						desc: item.model?.info?.meta?.description
					};
					return _item;
				})
			);
		}
	};

	$: if (allSelectableItems) {
		updateFuse();
	}

	const getItemAvailability = (item: { model?: Model }) =>
		getModelAvailability(item?.model ?? null, $models ?? []);

	const isItemDisabled = (item: { model?: Model }) => getItemAvailability(item).disabled;

	// Declared after isItemDisabled because it calls it.
	$: canSaveDefaultModel =
		Boolean(value) &&
		selectedModel !== null &&
		!isItemDisabled(selectedModel) &&
		!selectedModelIsDefault;

	const getItemDisabledReason = (item: { model?: Model }) =>
		getItemAvailability(item).disabledReason ?? 'Temporarily unavailable';

	const isLocalModelItem = (item: { label?: string; value?: string; model?: Model }) =>
		isLocalModelCandidate(item);

	const localModelsWarningText =
		'LM Studio is not running. Start LM Studio and enable the local server.';

	const sectionHasLocalWarning = (section: { key: string; items: { item: { model?: Model } }[] }) =>
		section.key === 'local' &&
		section.items.some((entry) => {
			const reason = getItemDisabledReason(entry.item);
			return isItemDisabled(entry.item) && reason.includes('LM Studio is not running');
		});

	const isHiddenItem = (item: { label?: string; value?: string; model?: Model }) =>
		isModelHidden(item?.model ?? null) || isLocalEmbeddingModelCandidate(item);

	const getInfoBaseModelId = (item: { model?: Model } | null | undefined) => {
		const model = item?.model ?? null;
		const info = model?.info ?? null;
		const candidate =
			model?.base_model_id ??
			model?.baseModelId ??
			info?.base_model_id ??
			info?.baseModelId ??
			null;

		if (candidate === null || candidate === undefined) {
			return null;
		}

		const normalized = `${candidate}`.trim();
		return normalized && normalized !== 'null' && normalized !== 'undefined' ? normalized : null;
	};

	const isSystemAgentItem = (item: { model?: Model }) =>
		getItemModelId(item).startsWith('portico_agent_');

	const isBaseModelCandidate = (item: { model?: Model }) =>
		!isSystemAgentItem(item) &&
		item?.model?.owned_by !== 'arena' &&
		!(item?.model?.direct ?? false);

	$: mergedBaseSourceItems = (() => {
		const existingItemsById = new Map(
			items.map((item) => [getItemModelId(item), item] as const).filter(([id]) => Boolean(id))
		);
		const storeItems = ($models ?? []).map((model) =>
			buildPickerItemFromModel(model, existingItemsById.get(normalizeModelId(model?.id)))
		);
		const passthroughItems = items
			.filter((item) => {
				const itemId = getItemModelId(item);
				return !itemId || !($models ?? []).some((model) => normalizeModelId(model?.id) === itemId);
			})
			.map((item) => buildPickerItemFromModel(item?.model, item));

		return dedupeSelectableItems([...storeItems, ...passthroughItems]);
	})();

	const loadWorkspaceAgentItems = async () => {
		if (workspaceAgentsLoading || workspaceAgentsLoaded || !localStorage?.token) {
			return;
		}

		workspaceAgentsLoading = true;

		try {
			const fetchedAgentItems: typeof items = [];
			let page = 1;
			let total = Infinity;

			while (fetchedAgentItems.length < total) {
				const response = await getWorkspaceModels(localStorage.token, '', '', '', null, null, page);
				const responseItems = Array.isArray(response?.items) ? response.items : [];

				if (responseItems.length === 0) {
					break;
				}

				total = Number.isFinite(response?.total) ? response.total : fetchedAgentItems.length + responseItems.length;

				for (const workspaceModel of responseItems) {
					const normalizedItem = buildWorkspaceAgentPickerItem(workspaceModel);

					if (!normalizedItem || isSystemAgentItem(normalizedItem) || !getInfoBaseModelId(normalizedItem)) {
						continue;
					}

					fetchedAgentItems.push(normalizedItem);
				}

				if (responseItems.length < 30) {
					break;
				}

				page += 1;
			}

			workspaceAgentItems = dedupeSelectableItems(fetchedAgentItems);
			workspaceAgentsLoaded = true;

			// First-open race: the initial tab decision ran before the agents
			// loaded. Re-run it now unless the user already picked a tab. The
			// derived workspaceAgentItemIds has not recomputed inside this async
			// function, so build the id set locally.
			if (show && !pickerTabUserOverride) {
				selectedPickerTab = resolveInitialPickerTab({
					selectedModelId: getItemModelId(selectedModel),
					selectedHasBaseModelId: Boolean(getInfoBaseModelId(selectedModel)),
					agentIds: new Set(workspaceAgentItems.map((item) => getItemModelId(item)))
				});
			}
		} catch (error) {
			console.error('[ModelSelector] Failed to load workspace agents:', error);
			workspaceAgentItems = [];
		} finally {
			workspaceAgentsLoading = false;
		}
	};

	$: workspaceAgentItemIds = new Set(workspaceAgentItems.map((item) => getItemModelId(item)));

	$: baseSelectableItems = mergedBaseSourceItems.filter(
		(item) =>
			isBaseModelCandidate(item) &&
			!workspaceAgentItemIds.has(getItemModelId(item)) &&
			getInfoBaseModelId(item) === null
	);

	$: baseSelectableItemIds = new Set(baseSelectableItems.map((item) => getItemModelId(item)));

	$: allSelectableItems = dedupeSelectableItems([...baseSelectableItems, ...workspaceAgentItems]);

	const getGroupedItemLogoSrc = (item: { value?: string; model?: Model }) => {
		return getModelLogoSources(
			item,
			WEBUI_API_BASE_URL,
			$i18n?.language || 'en',
			`${WEBUI_BASE_URL}/static/favicon.png`
		).light;
	};

	const getGroupedItemLogoDarkSrc = (item: { value?: string; model?: Model }) => {
		return getModelLogoSources(
			item,
			WEBUI_API_BASE_URL,
			$i18n?.language || 'en',
			`${WEBUI_BASE_URL}/static/favicon.png`
		).dark;
	};

	const handleGroupedItemLogoError = (event: Event) => {
		const img = event.currentTarget as HTMLImageElement;
		img.src = `${WEBUI_BASE_URL}/static/favicon.png`;
	};

	const matchesSelectedTag = (item: { model?: Model }) => {
		if (selectedTag === '') {
			return true;
		}

		return (item.model?.tags ?? [])
			.map((tag) => tag.name.toLowerCase())
			.includes(selectedTag.toLowerCase());
	};

	const isVisibleFilterTag = (tagName: string) => tagName !== 'local models';

	const getProviderGroupKey = (item: { label?: string; value?: string; model?: Model }) => {
		if (isLocalModelItem(item)) {
			return 'local';
		}

		const catalogProvider = resolveModelPickerMetadata(
			item?.model?.info?.base_model_id,
			item?.model?.base_model_id,
			item?.model?.id,
			item?.model?.name,
			item?.value,
			item?.label
		)?.pickerProvider;
		if (catalogProvider === 'anthropic') return 'claude';
		if (catalogProvider === 'openai') return 'openai';
		if (catalogProvider === 'google') return 'google';

		const haystack = `${item?.label ?? ''} ${item?.value ?? ''} ${item?.model?.id ?? ''}`.toLowerCase();

		if (haystack.includes('claude')) {
			return 'claude';
		}

		if (
			haystack.includes('openai') ||
			haystack.includes('chatgpt') ||
			haystack.includes('gpt') ||
			/\bo[134]\b/.test(haystack) ||
			/\bo[134]-/.test(haystack)
		) {
			return 'openai';
		}

		if (haystack.includes('gemini') || haystack.includes('google')) {
			return 'google';
		}

		if (haystack.includes('llama') || haystack.includes('meta')) {
			return 'other';
		}

		return 'other';
	};

	const providerGroupLabels: Record<string, string> = {
		claude: 'Anthropic',
		openai: 'OpenAI',
		google: 'Google',
		local: 'Local Models'
	};

	const providerGroupOrder = ['claude', 'openai', 'google', 'local'] as const;

	const getProviderGroupOrderRank = (item: (typeof items)[number]) => {
		const rank = providerGroupOrder.indexOf(
			getProviderGroupKey(item) as (typeof providerGroupOrder)[number]
		);
		return rank >= 0 ? rank : providerGroupOrder.length;
	};

	const getModelPickerTailRank = (item: (typeof items)[number]) =>
		resolveModelPricing(item?.model?.id ?? item?.value, item?.model?.name ?? item?.label)?.key ===
		'gpt-5.5'
			? 1
			: 0;

	const sortBaseModelsByGuideOrder = (candidateItems: typeof items) =>
		candidateItems
			.map((item, index) => ({ item, index }))
			.sort((left, right) => {
				const providerRankDifference =
					getProviderGroupOrderRank(left.item) - getProviderGroupOrderRank(right.item);
				if (providerRankDifference !== 0) {
					return providerRankDifference;
				}

				const tailRankDifference =
					getModelPickerTailRank(left.item) - getModelPickerTailRank(right.item);
				if (tailRankDifference !== 0) {
					return tailRankDifference;
				}

				const traitRankDifference =
					getModelTraitSortRankForModel(left.item.model) -
					getModelTraitSortRankForModel(right.item.model);
				if (traitRankDifference !== 0) {
					return traitRankDifference;
				}

				return left.index - right.index;
			})
			.map(({ item }) => item);

	$: hasBaseModels = baseSelectableItems.some((item) => !isHiddenItem(item));
	$: hasAgentModels = workspaceAgentItems.some((item) => !isHiddenItem(item));

	$: if (selectedPickerTab === 'models' && !hasBaseModels && hasAgentModels) {
		selectedPickerTab = 'agents';
	}

	// Guarded on workspaceAgentsLoaded: while the async agents load is still in
	// flight, hasAgentModels is false and this would flip an agent-selected
	// open back to Models.
	$: if (workspaceAgentsLoaded && selectedPickerTab === 'agents' && !hasAgentModels && hasBaseModels) {
		selectedPickerTab = 'models';
	}

	$: searchableItems =
		searchValue.trim() !== ''
			? fuse.search(searchValue).map((e) => {
					return e.item;
				})
			: selectedPickerTab === 'agents'
				? workspaceAgentItems
				: baseSelectableItems;

	$: unsortedFilteredItems = searchableItems
		.filter((item) => matchesSelectedTag(item))
		.filter((item) => !isHiddenItem(item));
	$: filteredItems =
		selectedPickerTab === 'models' && searchValue.trim() === ''
			? sortBaseModelsByGuideOrder(unsortedFilteredItems)
			: selectedPickerTab === 'agents' && searchValue.trim() === ''
				? orderAgentPickerItems(unsortedFilteredItems, value)
				: unsortedFilteredItems;
	$: isLoadingWorkspaceAgentSearch =
		searchValue.trim() !== '' &&
		Boolean(localStorage?.token) &&
		(workspaceAgentsLoading || !workspaceAgentsLoaded);

	$: visibleItems = filteredItems.slice(0, renderLimit || filteredItems.length);

	$: groupedBaseModelSections = providerGroupOrder
		.map((key) => {
			return {
				key,
				label: providerGroupLabels[key] ?? key,
				items: filteredItems
					.map((item, index) => ({ item, index }))
					.filter((entry) => getProviderGroupKey(entry.item) === key)
			};
		})
		.filter((section) => section.items.length > 0);

	$: groupedBaseModelGridClass =
		groupedBaseModelSections.length >= 4
			? 'md:grid-cols-4'
			: groupedBaseModelSections.length === 3
				? 'md:grid-cols-[1fr_0.95fr_0.86fr]'
			: groupedBaseModelSections.length === 2
				? 'md:grid-cols-2'
				: 'md:grid-cols-1';
	$: groupedBaseModelLayoutClass = shouldStackModelGuide
		? 'grid gap-4 pb-3'
		: composer
			? 'grid gap-4 pb-3 grid-cols-[minmax(0,1fr)_11.25rem]'
			: 'grid gap-3 pb-2 grid-cols-[minmax(0,1fr)_14.5rem]';
	$: sideGuideLayoutClass = shouldStackModelGuide
		? 'grid gap-4 pb-3'
		: composer
			? 'grid gap-4 pb-3 grid-cols-[minmax(0,1fr)_11.25rem]'
			: 'grid gap-3 pb-2 grid-cols-[minmax(0,1fr)_15.5rem]';
	$: unconstrainedModelSelectorContentClassName =
		className === DEFAULT_MODEL_SELECTOR_CLASS_NAME && groupedBaseModelSections.length >= 4
			? FOUR_PROVIDER_MODEL_SELECTOR_CLASS_NAME
			: className === DEFAULT_MODEL_SELECTOR_CLASS_NAME && groupedBaseModelSections.length === 3
				? THREE_PROVIDER_MODEL_SELECTOR_CLASS_NAME
				: className;
	$: modelSelectorContentClassName = modelSelectorConstrainedWidthPx
		? 'w-full'
		: composer
			? 'w-[68rem]'
			: unconstrainedModelSelectorContentClassName;
	$: modelSelectorContentStyle = buildModelSelectorContentStyle(
		modelSelectorConstrainedWidthPx,
		modelSelectorConstrainedMaxHeightPx
	);

	const updateModelSelectorAvailableSpace = async () => {
		if (!show || typeof window === 'undefined') {
			modelSelectorConstrainedWidthPx = null;
			modelSelectorConstrainedMaxHeightPx = null;
			shouldStackModelGuide = false;
			return;
		}

		await tick();

		const triggerElement = document.getElementById(`model-selector-${id}-button`);
		const triggerRect = triggerElement?.getBoundingClientRect();

		// Width/max-height constraint math lives in $lib/utils/modelSelectorLayout
		// (unit tested in tests/test_frontend_model_selection.cjs); this callback
		// only measures the DOM and applies the result.
		const layout = computeModelSelectorLayout({
			composer,
			isMobile: $mobile,
			viewportWidth: window.innerWidth,
			triggerLeft: triggerRect ? triggerRect.left : null,
			triggerTop: triggerRect ? triggerRect.top : null,
			desiredWidthPx: composer
				? COMPOSER_MODEL_SELECTOR_WIDTH_REM * 16
				: MODEL_SELECTOR_CLASS_WIDTHS_PX[unconstrainedModelSelectorContentClassName] ?? null,
			viewportPaddingPx: MODEL_SELECTOR_VIEWPORT_PADDING_PX,
			minConstrainedWidthPx: MODEL_SELECTOR_MIN_CONSTRAINED_WIDTH_PX,
			sideGuideMinWidthPx: MODEL_SELECTOR_SIDE_GUIDE_MIN_WIDTH_PX
		});

		modelSelectorConstrainedMaxHeightPx = layout.constrainedMaxHeightPx;
		modelSelectorConstrainedWidthPx = layout.constrainedWidthPx;
		shouldStackModelGuide = layout.shouldStackModelGuide;
	};

	$: if (show && unconstrainedModelSelectorContentClassName) {
		void updateModelSelectorAvailableSpace();
	}

	$: useGroupedBaseModelLayout =
		selectedPickerTab === 'models' &&
		searchValue.trim() === '' &&
		groupedBaseModelSections.length > 0;

	$: useSideGuideLayout =
		(selectedPickerTab === 'agents' || searchValue.trim() !== '') && !useGroupedBaseModelLayout;

	const findSelectableFilteredIndex = (startIndex: number, step: number) => {
		if (filteredItems.length === 0) {
			return -1;
		}

		let nextIndex = startIndex;
		while (nextIndex >= 0 && nextIndex < filteredItems.length) {
			if (!isItemDisabled(filteredItems[nextIndex])) {
				return nextIndex;
			}

			nextIndex += step;
		}

		return -1;
	};

	const getFirstSelectableFilteredIndex = () => findSelectableFilteredIndex(0, 1);

	const selectFilteredItem = (item: (typeof filteredItems)[number] | undefined, index: number) => {
		if (!item || isItemDisabled(item)) {
			return false;
		}

		value = item.value;
		selectedModelIdx = index;
		show = false;
		return true;
	};

	const clearDeferredRendering = () => {
		if (renderMoreFrame !== null) {
			window.cancelAnimationFrame(renderMoreFrame);
			renderMoreFrame = null;
		}
	};

	const scheduleDeferredRendering = () => {
		clearDeferredRendering();

		if (!show || renderLimit >= filteredItems.length) {
			return;
		}

		const renderNextChunk = () => {
			if (!show || renderLimit >= filteredItems.length) {
				renderMoreFrame = null;
				return;
			}

			renderLimit = Math.min(filteredItems.length, renderLimit + VISIBLE_MODELS_CHUNK);
			renderMoreFrame = window.requestAnimationFrame(renderNextChunk);
		};

		renderMoreFrame = window.requestAnimationFrame(renderNextChunk);
	};

	const ensureRenderedIndex = (index: number) => {
		if (index < 0) {
			return;
		}

		const minimumVisibleItems = Math.min(filteredItems.length, index + 1);
		if (minimumVisibleItems > renderLimit) {
			renderLimit = minimumVisibleItems;
		}

		scheduleDeferredRendering();
	};

	const refreshModelsInBackground = async () => {
		const now = Date.now();
		if (modelsRefreshInFlight || now - lastModelsRefreshAt < MODELS_REFRESH_COOLDOWN_MS) {
			return;
		}

		modelsRefreshInFlight = true;
		lastModelsRefreshAt = now;

		try {
			models.set(
				await getModels(
					localStorage.token,
					$config?.features?.enable_direct_connections && ($settings?.directConnections ?? null)
				)
			);
		} catch (error) {
			console.error('[ModelSelector] Failed to refresh model list:', error);
		} finally {
			modelsRefreshInFlight = false;
		}
	};

	$: if (show && filteredItems.length >= 0) {
		void resetView();
	}

	$: if (show && !workspaceAgentsLoaded) {
		void loadWorkspaceAgentItems();
	}

	const resetView = async () => {
		if (!show) {
			return;
		}

		await tick();

		const selectedInFiltered = filteredItems.findIndex((item) => item.value === value);

		if (selectedInFiltered >= 0 && !isItemDisabled(filteredItems[selectedInFiltered])) {
			// The selected model is visible in the current filter
			selectedModelIdx = selectedInFiltered;
		} else {
			// The selected model is not visible, default to the first selectable item.
			selectedModelIdx = Math.max(getFirstSelectableFilteredIndex(), 0);
		}

		renderLimit = Math.min(filteredItems.length, Math.max(INITIAL_VISIBLE_MODELS, selectedModelIdx + 1));
		scheduleDeferredRendering();

		await tick();
		const item = document.querySelector(`[data-arrow-selected="true"]`);
		item?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
	};

	const pullModelHandler = async () => {
		const sanitizedModelTag = searchValue.trim().replace(/^ollama\s+(run|pull)\s+/, '');

		console.log($MODEL_DOWNLOAD_POOL);
		if ($MODEL_DOWNLOAD_POOL[sanitizedModelTag]) {
			toast.error(
				$i18n.t(`Model '{{modelTag}}' is already in queue for downloading.`, {
					modelTag: sanitizedModelTag
				})
			);
			return;
		}
		if (Object.keys($MODEL_DOWNLOAD_POOL).length === 3) {
			toast.error(
				$i18n.t('Maximum of 3 models can be downloaded simultaneously. Please try again later.')
			);
			return;
		}

		const [res, controller] = await pullModel(localStorage.token, sanitizedModelTag, '0').catch(
			(error) => {
				toast.error(`${error}`);
				return null;
			}
		);

		if (res) {
			const reader = res.body
				.pipeThrough(new TextDecoderStream())
				.pipeThrough(splitStream('\n'))
				.getReader();

			MODEL_DOWNLOAD_POOL.set({
				...$MODEL_DOWNLOAD_POOL,
				[sanitizedModelTag]: {
					...$MODEL_DOWNLOAD_POOL[sanitizedModelTag],
					abortController: controller,
					reader,
					done: false
				}
			});

			while (true) {
				try {
					const { value, done } = await reader.read();
					if (done) break;

					let lines = value.split('\n');

					for (const line of lines) {
						if (line !== '') {
							let data = JSON.parse(line);
							console.log(data);
							if (data.error) {
								throw data.error;
							}
							if (data.detail) {
								throw data.detail;
							}

							if (data.status) {
								if (data.digest) {
									let downloadProgress = 0;
									if (data.completed) {
										downloadProgress = Math.round((data.completed / data.total) * 1000) / 10;
									} else {
										downloadProgress = 100;
									}

									MODEL_DOWNLOAD_POOL.set({
										...$MODEL_DOWNLOAD_POOL,
										[sanitizedModelTag]: {
											...$MODEL_DOWNLOAD_POOL[sanitizedModelTag],
											pullProgress: downloadProgress,
											digest: data.digest
										}
									});
								} else {
									toast.success(data.status);

									MODEL_DOWNLOAD_POOL.set({
										...$MODEL_DOWNLOAD_POOL,
										[sanitizedModelTag]: {
											...$MODEL_DOWNLOAD_POOL[sanitizedModelTag],
											done: data.status === 'success'
										}
									});
								}
							}
						}
					}
				} catch (error) {
					console.log(error);
					if (typeof error !== 'string') {
						error = error.message;
					}

					toast.error(`${error}`);
					// opts.callback({ success: false, error, modelName: opts.modelName });
					break;
				}
			}

			if ($MODEL_DOWNLOAD_POOL[sanitizedModelTag].done) {
				toast.success(
					$i18n.t(`Model '{{modelName}}' has been successfully downloaded.`, {
						modelName: sanitizedModelTag
					})
				);

				models.set(
					await getModels(
						localStorage.token,
						$config?.features?.enable_direct_connections && ($settings?.directConnections ?? null)
					)
				);
			} else {
				toast.error($i18n.t('Download canceled'));
			}

			delete $MODEL_DOWNLOAD_POOL[sanitizedModelTag];

			MODEL_DOWNLOAD_POOL.set({
				...$MODEL_DOWNLOAD_POOL
			});
		}
	};

	const setOllamaVersion = async () => {
		ollamaVersion = false;
	};

	$: tags = Array.from(
		new Set(
			allSelectableItems
				.filter((item) => !isHiddenItem(item))
				.flatMap((item) => item.model?.tags ?? [])
				.map((tag) => tag.name.toLowerCase())
				.filter(isVisibleFilterTag)
		)
	).sort((a, b) => a.localeCompare(b));

	$: if (selectedTag && !tags.includes(selectedTag)) {
		selectedTag = '';
	}

	onDestroy(() => {
		clearDeferredRendering();
		restoreNavOutsideDismiss();

		if (searchInputFocusTimer !== null) {
			window.clearTimeout(searchInputFocusTimer);
		}
	});

	$: if (show) {
		setOllamaVersion();
	}

	const cancelModelPullHandler = async (model: string) => {
		const { reader, abortController } = $MODEL_DOWNLOAD_POOL[model];
		if (abortController) {
			abortController.abort();
		}
		if (reader) {
			await reader.cancel();
			delete $MODEL_DOWNLOAD_POOL[model];
			MODEL_DOWNLOAD_POOL.set({
				...$MODEL_DOWNLOAD_POOL
			});
			await deleteModel(localStorage.token, model);
			toast.success($i18n.t('{{model}} download has been canceled', { model: model }));
		}
	};

	const unloadModelHandler = async (model: string) => {
		const res = await unloadModel(localStorage.token, model).catch((error) => {
			toast.error($i18n.t('Error unloading model: {{error}}', { error }));
		});

		if (res) {
			toast.success($i18n.t('Model unloaded successfully'));
			models.set(
				await getModels(
					localStorage.token,
					$config?.features?.enable_direct_connections && ($settings?.directConnections ?? null)
				)
			);
		}
	};
</script>

<svelte:window on:resize={updateModelSelectorAvailableSpace} />

<DropdownMenu.Root
	bind:open={show}
	onOpenChange={(isOpen) => {
		if (!isOpen) {
			clearDeferredRendering();
			restoreNavOutsideDismiss();
			modelSelectorConstrainedWidthPx = null;
			shouldStackModelGuide = false;

			if (searchInputFocusTimer !== null) {
				window.clearTimeout(searchInputFocusTimer);
				searchInputFocusTimer = null;
			}

			return;
		}

		enableNavOutsideDismiss();
		searchValue = '';
		pickerTabUserOverride = false;
		selectedPickerTab = resolveInitialPickerTab({
			selectedModelId: getItemModelId(selectedModel),
			selectedHasBaseModelId: Boolean(getInfoBaseModelId(selectedModel)),
			agentIds: workspaceAgentItemIds
		});
		renderLimit = INITIAL_VISIBLE_MODELS;
		scheduleDeferredRendering();

		if (searchInputFocusTimer !== null) {
			window.clearTimeout(searchInputFocusTimer);
		}

		searchInputFocusTimer = window.setTimeout(() => {
			document.getElementById('model-search-input')?.focus();
		}, 0);

		void refreshModelsInBackground();
		void resetView();
	}}
	closeFocus={false}
>
	<DropdownMenu.Trigger
		class="relative w-full {($settings?.highContrastMode ?? false)
			? ''
			: 'outline-hidden focus:outline-hidden'}"
		disabled={disabled}
		aria-label={placeholder}
		id="model-selector-{id}-button"
		>
			<div
				class="flex w-full items-center justify-between gap-2 bg-transparent px-0.5 text-left {triggerClassName} {($settings?.highContrastMode ??
				false)
					? 'dark:placeholder-gray-100 placeholder-gray-800'
					: 'placeholder-gray-400'}"
			>
				<div class="flex min-w-0 items-center gap-2">
					{#if showSelectedModelLogo && selectedModel}
						<div
							class={selectedModelLogoPresentation.wrapperClassName}
							data-selected-model-logo={selectedModel.value}
						>
							{#if selectedModelLogoSources.dark}
								<img
									src={selectedModelLogoSources.light}
									alt=""
									class="{selectedModelLogoPresentation.imageClassName} dark:hidden"
									loading="eager"
									decoding="async"
									on:error={handleGroupedItemLogoError}
								/>
								<img
									src={selectedModelLogoSources.dark ?? selectedModelLogoSources.light}
									alt=""
									class="{selectedModelLogoPresentation.imageClassName} hidden dark:block"
									loading="eager"
									decoding="async"
									on:error={handleGroupedItemLogoError}
								/>
							{:else}
								<img
									src={selectedModelLogoSources.light}
									alt=""
									class={selectedModelLogoPresentation.imageClassName}
									loading="eager"
									decoding="async"
									on:error={handleGroupedItemLogoError}
								/>
							{/if}
						</div>
					{/if}

					<div class="whitespace-nowrap">
						{#if selectedModel}
							{selectedModel.label}
						{:else}
							{placeholder}
						{/if}
					</div>

					<ModelTraitBadges
						traits={selectedModelTraitKeys}
						className={composer ? 'composer-model-trait-badges shrink-0' : 'shrink-0'}
						badgeClassName={composer ? 'size-5' : ''}
						iconClassName={composer ? 'size-3.5' : 'size-4.5'}
					/>
				</div>

				<ChevronDown className="size-3 shrink-0" strokeWidth="2.5" />
			</div>
	</DropdownMenu.Trigger>

	<DropdownMenu.Content
		class="model-selector-content z-[60] {$mobile
			? `w-full`
			: `${modelSelectorContentClassName}`} max-w-[calc(100vw-1rem)] justify-start rounded-xl border border-slate-300 bg-[var(--portico-light-canvas)] text-slate-900 shadow-[0_18px_48px_-24px_rgba(15,23,42,0.42)] dark:border-gray-800 dark:bg-gray-900 dark:text-white dark:shadow-[0_18px_48px_-24px_rgba(0,0,0,0.7)] outline-hidden {composer ? 'is-composer-model-selector' : ''}"
		style={modelSelectorContentStyle}
		data-composer-model-selector={composer ? 'true' : 'false'}
		transition={flyAndScale}
		side={$mobile ? 'bottom' : composer ? 'top' : 'bottom'}
		align={composer ? 'center' : 'start'}
		sideOffset={composer ? 12 : 2}
		alignOffset={composer ? 0 : -1}
		collisionPadding={12}
		avoidCollisions={!(composer && !$mobile)}
	>
		<slot>
			{#if searchEnabled}
				<div
					class="model-selector-search-row mx-4 mb-2 mt-4 flex h-9 max-w-[32rem] items-center gap-2.5 rounded-lg border border-slate-300 bg-slate-50 px-3 text-slate-500 transition-colors focus-within:border-slate-400 focus-within:ring-2 focus-within:ring-slate-400/20 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400 dark:focus-within:border-gray-700 dark:focus-within:ring-gray-700/30"
				>
					<Search className="size-4" strokeWidth="2.5" />

					<input
						id="model-search-input"
						bind:value={searchValue}
						class="model-selector-search-input w-full bg-transparent text-sm text-slate-700 placeholder:text-slate-400 outline-hidden dark:text-gray-100 dark:placeholder:text-gray-500"
						placeholder={searchPlaceholder}
						autocomplete="off"
						aria-label={$i18n.t('Search Models and Agents')}
						on:keydown={(e) => {
							if (e.code === 'Enter' && filteredItems.length > 0) {
								if (selectFilteredItem(filteredItems[selectedModelIdx], selectedModelIdx)) {
									return; // dont need to scroll on selection
								}
							} else if (e.code === 'ArrowDown') {
								e.stopPropagation();
								const nextIndex = findSelectableFilteredIndex(selectedModelIdx + 1, 1);
								if (nextIndex >= 0) {
									selectedModelIdx = nextIndex;
								}
							} else if (e.code === 'ArrowUp') {
								e.stopPropagation();
								const nextIndex = findSelectableFilteredIndex(selectedModelIdx - 1, -1);
								if (nextIndex >= 0) {
									selectedModelIdx = nextIndex;
								}
							} else {
								// if the user types something, reset to the top selection.
								selectedModelIdx = Math.max(getFirstSelectableFilteredIndex(), 0);
							}

							ensureRenderedIndex(selectedModelIdx);

							const item = document.querySelector(`[data-arrow-selected="true"]`);
							item?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
						}}
					/>
				</div>
			{/if}

			<div class="px-4">
				{#if tags && allSelectableItems.filter((item) => !isHiddenItem(item)).length > 0}
					<div
						class="flex w-full overflow-x-auto bg-transparent font-[450] scrollbar-none"
						on:wheel={(e) => {
							if (e.deltaY !== 0) {
								e.preventDefault();
								e.currentTarget.scrollLeft += e.deltaY;
							}
						}}
					>
						<div
							class="model-selector-tabs-track flex w-fit gap-0.5 whitespace-nowrap bg-transparent pb-2 pt-1 text-center text-xs dark:bg-transparent"
							bind:this={tagsContainerElement}
						>
							{#if hasBaseModels}
								<button
									class="model-selector-tab min-w-fit rounded-md px-2.5 py-1 outline-none transition-colors capitalize focus-visible:ring-2 focus-visible:ring-slate-500/40 {selectedPickerTab === 'models'
										? 'is-active dark:bg-gray-800 dark:text-white'
										: 'dark:text-gray-600 dark:hover:bg-gray-800/60 dark:hover:text-white'}"
									aria-pressed={selectedPickerTab === 'models'}
									on:click={() => {
										pickerTabUserOverride = true;
										selectedPickerTab = 'models';
									}}
								>
									{$i18n.t('Models')}
								</button>
							{/if}

							{#if hasAgentModels}
								<button
									class="model-selector-tab min-w-fit rounded-md px-2.5 py-1 outline-none transition-colors capitalize focus-visible:ring-2 focus-visible:ring-slate-500/40 {selectedPickerTab === 'agents'
										? 'is-active dark:bg-gray-800 dark:text-white'
										: 'dark:text-gray-600 dark:hover:bg-gray-800/60 dark:hover:text-white'}"
									aria-pressed={selectedPickerTab === 'agents'}
									on:click={() => {
										pickerTabUserOverride = true;
										selectedPickerTab = 'agents';
									}}
								>
									{$i18n.t('Agents')}
								</button>
							{/if}

							{#if showSetDefault}
								<button
									type="button"
									class="model-selector-tab model-selector-set-default-button ml-1 min-w-fit rounded-md px-2.5 py-1 font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-slate-500/40 disabled:cursor-default disabled:opacity-60 dark:text-gray-200 dark:hover:bg-gray-800 dark:disabled:bg-transparent"
									disabled={!canSaveDefaultModel || savingDefaultModel}
									aria-live="polite"
									aria-label={selectedModelIsDefault
										? $i18n.t('{{model}} is the default for new chats', {
												model: selectedModel?.label ?? value
											})
										: $i18n.t('Set {{model}} as default', {
												model: selectedModel?.label ?? value
											})}
									title={$i18n.t('Current default: {{model}}', {
										model: defaultModel?.label ?? defaultModelId
									})}
									on:click={async (event) => {
										event.preventDefault();
										event.stopPropagation();
										await setDefaultModelHandler(value);
									}}
								>
									{savingDefaultModel
										? $i18n.t('Saving...')
										: selectedModelIsDefault
											? $i18n.t('Default')
											: $i18n.t('Set as default')}
								</button>
							{/if}

							{#each tags as tag}
								<Tooltip content={tag}>
									<button
										class="model-selector-tab min-w-fit rounded-md px-2 py-1 outline-none transition-colors capitalize focus-visible:ring-2 focus-visible:ring-slate-500/40 {selectedTag === tag
											? 'is-active dark:bg-gray-800 dark:text-white'
											: 'dark:text-gray-600 dark:hover:bg-gray-800/60 dark:hover:text-white'}"
										aria-pressed={selectedTag === tag}
										on:click={() => {
											selectedTag = tag;
										}}
									>
										{tag.length > 16 ? `${tag.slice(0, 16)}...` : tag}
									</button>
								</Tooltip>
							{/each}
						</div>
						</div>
				{/if}
			</div>

			<div
				class="model-selector-scroll-region px-4 {useGroupedBaseModelLayout || useSideGuideLayout
					? 'max-h-[min(70vh,34rem)]'
					: 'max-h-64'} overflow-y-auto group relative"
			>
				{#if useGroupedBaseModelLayout}
					<div class={groupedBaseModelLayoutClass}>
						<div
							class="model-selector-sections grid divide-y divide-slate-300/70 md:divide-x md:divide-y-0 dark:divide-gray-800 {groupedBaseModelGridClass}"
						>
							{#each groupedBaseModelSections as section (section.key)}
								<section class="model-selector-section min-w-0 self-start px-2.5 py-1.5 md:px-3.5">
									<div class="flex items-center gap-1.5 px-2 pb-2 pt-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-gray-400">
										{section.label}
										{#if sectionHasLocalWarning(section)}
											<Tooltip content={localModelsWarningText}>
												<span class="flex items-center text-amber-600 dark:text-amber-400" aria-label={localModelsWarningText}>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														viewBox="0 0 20 20"
														fill="currentColor"
														class="size-3.5"
													>
														<path
															fill-rule="evenodd"
															d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.19-1.458-1.516-2.625L8.485 2.495ZM10 5.75a.75.75 0 0 1 .75.75v3.25a.75.75 0 0 1-1.5 0V6.5A.75.75 0 0 1 10 5.75Zm0 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
															clip-rule="evenodd"
														/>
													</svg>
												</span>
											</Tooltip>
										{/if}
									</div>

									<div class="space-y-1">
										{#each section.items as entry (entry.item.value)}
											{@const isDisabled = isItemDisabled(entry.item)}
											{@const logoPresentation = getModelSelectorLogoPresentation(entry.item, 'grouped')}
											{@const isLocalModel = isLocalModelItem(entry.item)}
											{@const modelTraitKeys = resolveModelTraitKeysForModel(entry.item.model)}
											{@const keepDisabledTraitBadgeVivid =
												getCelestialModelIdentity(entry.item) === 'sol' && modelTraitKeys.includes('premium')}
											<button
												class="model-selector-group-item grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center rounded-lg border border-transparent px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:border-slate-400 focus-visible:ring-2 focus-visible:ring-slate-400/25 dark:focus-visible:border-gray-700 dark:focus-visible:ring-gray-700/40 {isDisabled
													? 'cursor-not-allowed border-transparent bg-transparent text-slate-400 dark:border-transparent dark:bg-transparent dark:text-gray-500'
													: 'hover:bg-slate-300/70 dark:hover:bg-gray-800'} {entry.index ===
												selectedModelIdx && !isDisabled
													? 'is-selected bg-slate-300/80 dark:bg-gray-800'
													: ''}"
												aria-disabled={isDisabled}
												data-arrow-selected={entry.index === selectedModelIdx}
												data-value={entry.item.value}
												on:click={() => {
													selectFilteredItem(entry.item, entry.index);
												}}
											>
												<div class="model-selector-group-main flex min-w-0 items-center gap-2.5 pr-1">
													<div class={`${logoPresentation.wrapperClassName} ${isDisabled ? 'opacity-50 grayscale' : ''}`.trim()}>
														{#if isLocalModel}
															<img
																src={getGroupedItemLogoSrc(entry.item)}
																alt={entry.item.label}
																class="{logoPresentation.imageClassName} dark:hidden"
																loading="eager"
																decoding="async"
															/>
															<img
																src={getGroupedItemLogoDarkSrc(entry.item) ?? getGroupedItemLogoSrc(entry.item)}
																alt={entry.item.label}
																class="{logoPresentation.imageClassName} hidden dark:block"
																loading="eager"
																decoding="async"
															/>
														{:else}
															<img
																src={getGroupedItemLogoSrc(entry.item)}
																alt={entry.item.label}
																class={logoPresentation.imageClassName}
																loading="eager"
																decoding="async"
																on:error={handleGroupedItemLogoError}
															/>
														{/if}
													</div>

											<div class="min-w-0 flex-1">
												<div
													class="model-selector-group-label min-w-0 whitespace-nowrap text-sm leading-tight {value === entry.item.value && !isDisabled ? 'font-bold' : 'font-medium'}"
															data-model-picker-label={entry.item.value}
														>
															{entry.item.label}
														</div>
														{#if entry.item.model?.info?.meta?.description}
															<div class="line-clamp-1 text-xs {isDisabled
																? 'text-slate-400 dark:text-gray-500'
																: 'text-slate-500 dark:text-gray-400'}">
																{entry.item.model.info.meta.description}
															</div>
														{/if}
													</div>
												</div>

												<div class="model-selector-group-actions ml-2 flex shrink-0 items-center gap-1.5 justify-self-end">
													{#if isDisabled}
														<Tooltip content={getItemDisabledReason(entry.item)}>
															<div class="flex shrink-0 items-center text-slate-400 dark:text-gray-500">
																<svg
																	xmlns="http://www.w3.org/2000/svg"
																	viewBox="0 0 20 20"
																	fill="currentColor"
																	class="size-4"
																>
																	<path
																		fill-rule="evenodd"
																		d="M10 1.75a4.25 4.25 0 0 0-4.25 4.25v2.086A2.75 2.75 0 0 0 3.5 10.75v4a2.75 2.75 0 0 0 2.75 2.75h7.5a2.75 2.75 0 0 0 2.75-2.75v-4a2.75 2.75 0 0 0-2.25-2.664V6A4.25 4.25 0 0 0 10 1.75Zm2.75 6.25V6a2.75 2.75 0 1 0-5.5 0v2h5.5Z"
																		clip-rule="evenodd"
																	/>
																</svg>
															</div>
														</Tooltip>
													{/if}
													{#if value === entry.item.value && !isDisabled}
														<div class="shrink-0">
															<Check className="size-3" />
														</div>
													{/if}
													{#if !isLocalModel}
														<ModelTraitBadges
															traits={modelTraitKeys}
															className={isDisabled && !keepDisabledTraitBadgeVivid
																? 'shrink-0 opacity-50 grayscale'
																: 'shrink-0'}
														/>
													{/if}
												</div>
											</button>
										{/each}
									</div>
								</section>
							{/each}
						</div>

						<ModelGuide
							stacked={shouldStackModelGuide}
							compact={composer && shouldStackModelGuide}
							concise={composer}
							className={composer && !shouldStackModelGuide ? 'model-selector-guide-rail' : ''}
						/>
					</div>
				{:else if useSideGuideLayout}
					<div class={sideGuideLayoutClass}>
						<div>
							{#if filteredItems.length === 0}
								<div class="block px-3 py-2 text-sm text-slate-700 dark:text-gray-100">
									{isLoadingWorkspaceAgentSearch
										? $i18n.t('Loading agents...')
										: $i18n.t('No results found')}
								</div>
							{:else}
								{#each visibleItems as item, index}
									<ModelItem
										{selectedModelIdx}
										{item}
										{index}
										{value}
										disableTooltips={selectedPickerTab === 'agents'}
										{pinModelHandler}
										{unloadModelHandler}
										onClick={() => {
											value = item.value;
											selectedModelIdx = index;

											show = false;
										}}
									/>
								{/each}

								{#if visibleItems.length < filteredItems.length}
									<div class="px-3 py-2 text-xs text-slate-500 dark:text-gray-400">
										{$i18n.t('Loading models...')}
									</div>
								{/if}
							{/if}
						</div>

						<ModelGuide
							stacked={shouldStackModelGuide}
							compact={composer && shouldStackModelGuide}
							concise={composer}
							className={composer && !shouldStackModelGuide ? 'model-selector-guide-rail' : ''}
							showTooltips={selectedPickerTab !== 'agents'}
						/>
					</div>
				{:else}
					{#if filteredItems.length === 0}
						<div class="">
							<div class="block px-3 py-2 text-sm text-slate-700 dark:text-gray-100">
								{isLoadingWorkspaceAgentSearch
									? $i18n.t('Loading agents...')
									: $i18n.t('No results found')}
							</div>
						</div>
					{:else}
					{#each visibleItems as item, index}
						<ModelItem
							{selectedModelIdx}
							{item}
							{index}
							{value}
							{pinModelHandler}
							{unloadModelHandler}
							onClick={() => {
								value = item.value;
								selectedModelIdx = index;

								show = false;
							}}
						/>
					{/each}

					{#if visibleItems.length < filteredItems.length}
						<div class="px-3 py-2 text-xs text-slate-500 dark:text-gray-400">
							{$i18n.t('Loading models...')}
						</div>
					{/if}
					{/if}
				{/if}

				{#if !(searchValue.trim() in $MODEL_DOWNLOAD_POOL) && searchValue && ollamaVersion && $user?.role === 'admin'}
					<Tooltip
						content={$i18n.t(`Pull "{{searchValue}}" from Ollama.com`, {
							searchValue: searchValue
						})}
						placement="top-start"
					>
						<button
							class="flex min-h-11 w-full cursor-pointer select-none items-center rounded-lg border border-transparent py-1.5 pl-2 pr-1.5 text-sm font-medium text-slate-700 outline-none transition-colors hover:bg-slate-300/70 focus-visible:border-slate-400 focus-visible:ring-2 focus-visible:ring-slate-400/25 data-highlighted:bg-muted dark:text-gray-100 dark:hover:bg-gray-800 dark:focus-visible:border-gray-700 dark:focus-visible:ring-gray-700/40"
							on:click={() => {
								pullModelHandler();
							}}
						>
							<div class=" truncate">
								{$i18n.t(`Pull "{{searchValue}}" from Ollama.com`, { searchValue: searchValue })}
							</div>
						</button>
					</Tooltip>
				{/if}

				{#each Object.keys($MODEL_DOWNLOAD_POOL) as model}
					<div
						class="flex min-h-11 w-full cursor-pointer select-none items-center justify-between rounded-lg py-1.5 pl-2 pr-1.5 text-sm font-medium text-gray-700 outline-none data-highlighted:bg-muted dark:text-gray-100"
					>
						<div class="flex">
							<div class="mr-2.5 translate-y-0.5">
								<Spinner />
							</div>

							<div class="flex flex-col self-start">
								<div class="flex gap-1">
									<div class="line-clamp-1">
										Downloading "{model}"
									</div>

									<div class="shrink-0">
										{'pullProgress' in $MODEL_DOWNLOAD_POOL[model]
											? `(${$MODEL_DOWNLOAD_POOL[model].pullProgress}%)`
											: ''}
									</div>
								</div>

								{#if 'digest' in $MODEL_DOWNLOAD_POOL[model] && $MODEL_DOWNLOAD_POOL[model].digest}
									<div class="-mt-1 h-fit text-[0.7rem] dark:text-gray-500 line-clamp-1">
										{$MODEL_DOWNLOAD_POOL[model].digest}
									</div>
								{/if}
							</div>
						</div>

						<div class="mr-2 ml-1 translate-y-0.5">
							<Tooltip content={$i18n.t('Cancel')}>
								<button
									class="text-gray-800 dark:text-gray-100"
									on:click={() => {
										cancelModelPullHandler(model);
									}}
								>
									<svg
										class="w-4 h-4 text-gray-800 dark:text-white"
										aria-hidden="true"
										xmlns="http://www.w3.org/2000/svg"
										width="24"
										height="24"
										fill="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											stroke="currentColor"
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M6 18 17.94 6M18 18 6.06 6"
										/>
									</svg>
								</button>
							</Tooltip>
						</div>
					</div>
				{/each}
			</div>

			{#if !useGroupedBaseModelLayout && !useSideGuideLayout}
				<ModelGuide stacked className="mx-3 mt-3" />
			{/if}

			<div class="mb-2.5"></div>

			<div class="hidden w-[42rem]"></div>
			<div class="hidden w-[32rem]"></div>
			<div class="hidden w-[56rem]"></div>
		</slot>
	</DropdownMenu.Content>
</DropdownMenu.Root>
