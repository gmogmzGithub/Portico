<script lang="ts">
	// PORTICO_PATCH (multi-chat tiling): route through MultiChatContainer so a
	// chat created from the home route (URL set via history.replaceState — no
	// remount) still enters the tiled layout live when it starts peer chats.
	// Mirrors upstream v0.6.43 otherwise.
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';

	import MultiChatContainer from '$lib/components/chat/MultiChatContainer.svelte';
	import { page } from '$app/stores';

	onMount(() => {
		if ($page.url.searchParams.get('error')) {
			toast.error($page.url.searchParams.get('error') || 'An unknown error occurred.');
		}
	});
</script>

<MultiChatContainer />
