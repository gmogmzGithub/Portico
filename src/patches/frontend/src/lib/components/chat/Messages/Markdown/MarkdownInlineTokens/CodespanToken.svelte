<script lang="ts">
	import { copyToClipboard, unescapeHtml } from '$lib/utils';
	import { getChatLinkAction } from '$lib/utils/chat-link-interaction.mjs';
	import { toast } from 'svelte-sonner';
	import { fade } from 'svelte/transition';

	import { getContext } from 'svelte';

	const i18n = getContext('i18n');

	export let token;
	export let done = true;

	const handleCodeSpanClick = (event: MouseEvent) => {
		const text = unescapeHtml(token.text);
		const decision = getChatLinkAction(event, text);
		if (decision.action === 'open' && decision.url) {
			event.preventDefault();
			window.open(decision.url, '_blank', 'noopener,noreferrer');
			return;
		}

		copyToClipboard(text);
		toast.success($i18n.t('Copied to clipboard'));
	};
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
{#if done}
	<code
		class="codespan cursor-pointer"
		on:click={handleCodeSpanClick}>{unescapeHtml(token.text)}</code
	>
{:else}
	<code
		transition:fade={{ duration: 100 }}
		class="codespan cursor-pointer"
		on:click={handleCodeSpanClick}>{unescapeHtml(token.text)}</code
	>
{/if}
