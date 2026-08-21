<script lang="ts">
	// PORTICO_PATCH (multi-chat tiling): route through MultiChatContainer, which
	// renders a plain Chat for ordinary chats and the tiled multi-pane layout
	// for chats with start_chat panes. Mirrors upstream v0.6.43 otherwise.
	import { page } from '$app/stores';

	import MultiChatContainer from '$lib/components/chat/MultiChatContainer.svelte';
</script>

<MultiChatContainer chatIdProp={$page.params.id} />
