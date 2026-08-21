<script lang="ts">
	import type { SuggestionVisualKind } from '$lib/utils/suggestionVisual';

	export let kind: SuggestionVisualKind = 'prompt';

	$: toneClass =
		kind === 'welcome'
			? 'bg-amber-100/80 text-amber-700 dark:bg-amber-300/10 dark:text-amber-200'
			: kind === 'integrations'
				? 'bg-teal-100/80 text-teal-700 dark:bg-teal-300/10 dark:text-teal-200'
				: kind === 'meetings'
					? 'bg-violet-100/80 text-violet-700 dark:bg-violet-300/10 dark:text-violet-200'
					: kind === 'portico'
						? 'bg-[#e8f0ff] text-[#2557a7] dark:bg-[#2557a7]/25 dark:text-[#8db5ff]'
						: 'bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-slate-300';
</script>

<span
	class="flex size-9 shrink-0 select-none items-center justify-center rounded-xl {toneClass}"
	aria-hidden="true"
	data-suggestion-icon={kind}
>
	{#if kind === 'welcome'}
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
			class="size-[1.2rem]"
		>
			<path d="m12 3 1.15 3.35a4.75 4.75 0 0 0 3 3L19.5 10.5l-3.35 1.15a4.75 4.75 0 0 0-3 3L12 18l-1.15-3.35a4.75 4.75 0 0 0-3-3L4.5 10.5l3.35-1.15a4.75 4.75 0 0 0 3-3L12 3Z" />
			<path d="m18.25 3.5.4 1.15a1.65 1.65 0 0 0 1.05 1.05l1.15.4-1.15.4a1.65 1.65 0 0 0-1.05 1.05l-.4 1.15-.4-1.15A1.65 1.65 0 0 0 16.8 6.5l-1.15-.4 1.15-.4a1.65 1.65 0 0 0 1.05-1.05l.4-1.15Z" />
		</svg>
	{:else if kind === 'integrations'}
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
			class="size-[1.15rem]"
		>
			<path d="M9 3v4M15 3v4M7 7h10v2a5 5 0 0 1-5 5 5 5 0 0 1-5-5V7Z" />
			<path d="M12 14v7" />
		</svg>
	{:else if kind === 'meetings'}
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
			class="size-[1.15rem]"
		>
			<path d="M6.75 3v3M17.25 3v3M4 9h16" />
			<rect x="4" y="5" width="16" height="15" rx="2.5" />
			<path d="m8.5 14 2 2 4.5-4.5" />
		</svg>
	{:else if kind === 'portico'}
		<svg
			viewBox="0 0 32 32"
			fill="none"
			class="size-[1.45rem] overflow-visible"
			aria-hidden="true"
			data-portico-mark
		>
			<!-- Portico's standalone mark: the lowercase i and its distinctive over-dot arc. -->
			<path
				d="M6.5 10.8C10.1 4.8 19.15 2.7 25.6 7.1"
				transform="translate(0 -1)"
				stroke="currentColor"
				stroke-width="2.35"
				stroke-linecap="round"
			/>
			<circle cx="17" cy="11.15" r="2.55" fill="currentColor" />
			<path
				d="M14.45 15.15h5.1v9.15a2.55 2.55 0 0 1-5.1 0v-9.15Z"
				fill="currentColor"
			/>
		</svg>
	{:else}
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
			class="size-[1.15rem]"
		>
			<path d="m12 3 1.15 3.35a4.75 4.75 0 0 0 3 3L19.5 10.5l-3.35 1.15a4.75 4.75 0 0 0-3 3L12 18l-1.15-3.35a4.75 4.75 0 0 0-3-3L4.5 10.5l3.35-1.15a4.75 4.75 0 0 0 3-3L12 3Z" />
		</svg>
	{/if}
</span>
