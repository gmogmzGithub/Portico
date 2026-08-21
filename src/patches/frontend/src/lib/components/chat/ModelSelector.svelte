<script lang="ts">
	import { config, models, settings } from '$lib/stores';
	import { getContext } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Selector from './ModelSelector/Selector.svelte';
	import { updateUserSettings } from '$lib/apis/users';
	import {
		resolveEffectiveDefaultModelId,
		resolveEnabledSelectedModelIds
	} from '$lib/utils/modelSelection';

	const i18n = getContext('i18n');

	export let selectedModels = [''];
	export let disabled = false;
	export let compact = false;
	export let formField = false;
	export let placeholder = $i18n.t('Select a model');

	// Derived rather than passed in: only the composer placement should be able
	// to change a global default. Form-field placements (the scheduled-tasks
	// picker) must never offer it, and deriving here means callers cannot opt in
	// by accident.
	$: showSetDefault = compact && !formField;

	let savingDefaultModel = false;
	let effectiveDefaultModelId = '';

	$: effectiveDefaultModelId = resolveEffectiveDefaultModelId({
		userDefaultModels: $settings?.models,
		configDefaultModels: $config?.default_models,
		models: $models ?? []
	});

	const saveDefaultModel = async (modelId: string) => {
		if (savingDefaultModel) {
			return;
		}

		const selectedModelId = resolveEnabledSelectedModelIds([modelId], $models ?? [])[0] ?? '';
		if (!selectedModelId) {
			toast.error($i18n.t('Choose a model before saving...'));
			return;
		}

		const nextSettings = { ...($settings ?? {}), models: [selectedModelId] };
		savingDefaultModel = true;

		try {
			// Persist first, then mirror locally. Deliberately pessimistic, unlike
			// pinModelHandler below: /api/v1/users/user/settings/update is a
			// model-reconcile mutation path and can return 409 while a reconcile
			// holds the writer lease. On failure the local store must not diverge
			// from the server.
			await updateUserSettings(localStorage.token, { ui: nextSettings });
			settings.set(nextSettings);
			// An explicit, durable choice supersedes the implicit one-shot
			// last-used carry-forward, so drop it and let the new default apply.
			sessionStorage.removeItem('selectedModels');
			toast.success($i18n.t('Default model updated'));
		} catch (error) {
			console.error('[ModelSelector] Failed to update the default model:', error);
			toast.error($i18n.t('Failed to update the default model'));
		} finally {
			savingDefaultModel = false;
		}
	};

	const pinModelHandler = async (modelId) => {
		let pinnedModels = $settings?.pinnedModels ?? [];
		pinnedModels = pinnedModels.includes(modelId)
			? pinnedModels.filter((id) => id !== modelId)
			: [...new Set([...pinnedModels, modelId])];

		settings.set({ ...$settings, pinnedModels });
		await updateUserSettings(localStorage.token, { ui: $settings });
	};

	$: if (selectedModels.length > 0 && $models.length > 0) {
		const validSelectedModels = selectedModels.map((model) =>
			$models.some((candidate) => candidate.id === model) ? model : ''
		);

		if (JSON.stringify(validSelectedModels) !== JSON.stringify(selectedModels)) {
			selectedModels = validSelectedModels;
		}
	}

	// The service contract remains an array, but the chat shell intentionally
	// exposes one primary model until the multi-model experience is redesigned.
	$: if (selectedModels.length > 1) {
		selectedModels = [selectedModels[0]];
	}
</script>

<div
	class="flex flex-col items-start {compact ? 'composer-model-picker w-auto min-w-0' : 'w-full'}"
	data-model-selector-placement={compact ? 'composer' : formField ? 'form' : 'navbar'}
>
	{#each selectedModels as selectedModel, selectedModelIdx}
		<div
			class="flex max-w-full items-center {compact
				? 'composer-model-picker-row'
				: formField
					? 'w-full'
					: 'w-full max-w-fit'}"
		>
			<div class="min-w-0 overflow-hidden {compact ? 'w-auto' : 'w-full'}">
				<div
					class="max-w-full {compact || formField
						? ''
						: ($settings?.highContrastMode ?? false)
							? 'm-1'
							: 'mr-1'}"
				>
					<Selector
						id={`${selectedModelIdx}`}
						{placeholder}
						{disabled}
						items={$models.map((model) => ({
							value: model.id,
							label: model.name,
							model
						}))}
						{pinModelHandler}
						{showSetDefault}
						defaultModelId={effectiveDefaultModelId}
						setDefaultModelHandler={saveDefaultModel}
						{savingDefaultModel}
						showSelectedModelLogo={formField}
						composer={compact || formField}
						triggerClassName={compact
							? 'text-xs font-medium'
							: formField
								? 'text-sm font-normal'
								: 'text-lg'}
						bind:value={selectedModel}
					/>
				</div>
			</div>
		</div>
	{/each}
</div>
