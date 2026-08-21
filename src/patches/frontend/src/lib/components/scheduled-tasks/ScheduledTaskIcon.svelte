<script lang="ts">
	export let kind:
		| 'hero'
		| 'enabled'
		| 'paused'
		| 'next'
		| 'failed'
		| 'empty'
		| 'history' = 'hero';
	export let size = 24;
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.8"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	data-scheduled-task-icon={kind}
>
	{#if kind === 'enabled'}
		<path d="M8 3v3M16 3v3M4.5 9h15" />
		<rect x="3.5" y="5" width="17" height="16" rx="3" />
		<path d="m8.5 15 2.2 2.2 4.8-5" />
	{:else if kind === 'paused'}
		<circle cx="12" cy="12" r="8.5" />
		<path d="M9.5 9v6M14.5 9v6" />
	{:else if kind === 'next'}
		<circle cx="12" cy="12" r="8.5" />
		<path d="M12 7.5V12l3 2" />
	{:else if kind === 'failed'}
		<path d="M12 3.5 21 20H3L12 3.5Z" />
		<path d="M12 9v4M12 16.5h.01" />
	{:else if kind === 'history'}
		<path d="M4 12a8 8 0 1 0 2.35-5.65L4 8.7" />
		<path d="M4 4.5v4.2h4.2M12 8v4.4l2.8 1.7" />
	{:else}
		<path d="M8 3v3M16 3v3M4.5 9h15" />
		<rect x="3.5" y="5" width="17" height="16" rx="3" />
		{#if kind === 'empty'}
			<path d="M8 14h8M12 10v8" />
		{:else}
			<path d="M8.5 13.5h3v3h-3zM14 13.5h1.5M14 16.5h1.5" />
		{/if}
	{/if}
</svg>
