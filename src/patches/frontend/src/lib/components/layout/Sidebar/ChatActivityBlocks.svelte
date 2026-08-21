<script lang="ts">
	export let label = 'Chat is active';
</script>

<span class="chat-activity-blocks" role="img" aria-label={label} title={label}>
	<span></span><span></span><span></span><span></span>
</span>

<style>
	.chat-activity-blocks {
		--chat-activity-block-color: #0b5fff;
		--chat-activity-block-rest-opacity: 0.38;
		display: inline-grid;
		width: 12px;
		height: 12px;
		flex: 0 0 12px;
		place-content: center;
		grid-template-columns: repeat(2, 4px);
		grid-template-rows: repeat(2, 4px);
		gap: 2px;
	}

	.chat-activity-blocks > span {
		width: 4px;
		height: 4px;
		border-radius: 1px;
		background: var(--chat-activity-block-color);
		opacity: var(--chat-activity-block-rest-opacity);
		transform: scale(0.72);
		animation: chat-activity-block-pulse 1.05s ease-in-out infinite;
		box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.42);
	}

	.chat-activity-blocks > span:nth-child(2) {
		animation-delay: 120ms;
	}

	.chat-activity-blocks > span:nth-child(4) {
		animation-delay: 240ms;
	}

	.chat-activity-blocks > span:nth-child(3) {
		animation-delay: 360ms;
	}

	@keyframes chat-activity-block-pulse {
		0%,
		58%,
		100% {
			opacity: var(--chat-activity-block-rest-opacity);
			transform: scale(0.72);
		}
		22% {
			opacity: 1;
			transform: scale(1);
		}
	}

	:global(.light .selected) .chat-activity-blocks {
		--chat-activity-block-color: #0047b3;
		--chat-activity-block-rest-opacity: 0.5;
	}

	:global(.dark) .chat-activity-blocks {
		--chat-activity-block-color: #60a5fa;
		--chat-activity-block-rest-opacity: 0.3;
	}

	@media (prefers-reduced-motion: reduce) {
		.chat-activity-blocks > span {
			opacity: 0.72;
			transform: none;
			animation: none;
		}
	}
</style>
