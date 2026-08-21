<script lang="ts">
	import { settings } from '$lib/stores';
	import { getContext, onMount } from 'svelte';
	import { setTextScale, getTextScale } from '$lib/utils/text-scale';

	import Minus from '$lib/components/icons/Minus.svelte';
	import Plus from '$lib/components/icons/Plus.svelte';

	const i18n = getContext('i18n');

	export let saveSettings: Function;

	let textScale: number | null = null;

	const setTextScaleHandler = (scale: number) => {
		textScale = scale;
		setTextScale(textScale);

		if (textScale === 1) {
			textScale = null;
		}

		saveSettings({ textScale });
	};

	onMount(() => {
		// Read the live CSS variable so keyboard-shortcut changes are reflected.
		const liveScale = getTextScale();
		textScale = liveScale ?? $settings?.textScale ?? null;
	});
</script>

<div id="tab-interface" class="flex h-full flex-col justify-start text-sm">
	<div class="space-y-3 overflow-y-auto max-h-[28rem] md:max-h-full">
		<div>
			<h1 class="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">
				{$i18n.t('UI')}
			</h1>

			<div>
				<div class="flex w-full justify-between py-0.5">
					<label
						id="ui-scale-label"
						class="self-center text-xs text-gray-800 dark:text-gray-200"
						for="ui-scale-slider"
					>
						{$i18n.t('UI Scale')}
					</label>

					<div class="flex items-center gap-2 p-1">
						<button
							class="text-xs font-medium text-gray-700 dark:text-gray-200"
							aria-live="polite"
							type="button"
							on:click={() => {
								if (textScale === null) {
									textScale = 1;
								} else {
									textScale = null;
									setTextScaleHandler(1);
								}
							}}
						>
							{#if textScale === null}
								<span>{$i18n.t('Default')}</span>
							{:else}
								<span>{textScale}x</span>
							{/if}
						</button>
					</div>
				</div>

				{#if textScale !== null}
					<div class="flex items-center gap-2 px-1 pb-1">
						<button
							type="button"
							class="rounded-lg p-1 transition outline-gray-300 hover:bg-gray-100 dark:outline-gray-700 dark:hover:bg-gray-800"
							on:click={() => {
								textScale = Math.max(1, parseFloat((textScale - 0.1).toFixed(2)));
								setTextScaleHandler(textScale);
							}}
							aria-labelledby="ui-scale-label"
							aria-label={$i18n.t('Decrease UI Scale')}
						>
							<Minus className="h-3.5 w-3.5" />
						</button>

						<div class="flex flex-1 items-center">
							<input
								id="ui-scale-slider"
								class="w-full"
								type="range"
								min="1"
								max="1.5"
								step={0.01}
								bind:value={textScale}
								on:change={() => {
									setTextScaleHandler(textScale);
								}}
								aria-labelledby="ui-scale-label"
								aria-valuemin="1"
								aria-valuemax="1.5"
								aria-valuenow={textScale}
								aria-valuetext={`${textScale}x`}
							/>
						</div>

						<button
							type="button"
							class="rounded-lg p-1 transition outline-gray-300 hover:bg-gray-100 dark:outline-gray-700 dark:hover:bg-gray-800"
							on:click={() => {
								textScale = Math.min(1.5, parseFloat((textScale + 0.1).toFixed(2)));
								setTextScaleHandler(textScale);
							}}
							aria-labelledby="ui-scale-label"
							aria-label={$i18n.t('Increase UI Scale')}
						>
							<Plus className="h-3.5 w-3.5" />
						</button>
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>
