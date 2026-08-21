<script lang="ts">
	import { WEBUI_BASE_URL } from '$lib/constants';
	import { settings, playingNotificationSound, isLastActiveTab } from '$lib/stores';
	import DOMPurify from 'dompurify';

	import { marked } from 'marked';
	import { createEventDispatcher, onMount } from 'svelte';

	const dispatch = createEventDispatcher();

	export let onClick: Function = () => {};
	export let title: string = 'HI';
	export let content: string;

	let startX = 0,
		startY = 0;
	let moved = false;
	const DRAG_THRESHOLD_PX = 6;

	const clickHandler = () => {
		onClick();
		dispatch('closeToast');
	};

	function onPointerDown(e: PointerEvent) {
		startX = e.clientX;
		startY = e.clientY;
		moved = false;
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
	}

	function onPointerMove(e: PointerEvent) {
		if (moved) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
			moved = true;
		}
	}

	function onPointerUp(e: PointerEvent) {
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
		if (!moved) {
			clickHandler();
		}
	}

	onMount(() => {
		// The Electron shell replaces this toast with a native notification.
		// Avoid playing the legacy toast sound there as well.
		if (document.documentElement.classList.contains('portico-electron-shell')) {
			return;
		}
		if (!navigator.userActivation.hasBeenActive) {
			return;
		}
		if ($settings?.notificationSound ?? true) {
			if (!$playingNotificationSound && $isLastActiveTab) {
				playingNotificationSound.set(true);
				const audio = new Audio(`/audio/notification.mp3`);
				audio.play().finally(() => {
					playingNotificationSound.set(false);
				});
			}
		}
	});
</script>

<!-- PORTICO PATCH: tagged so Electron-hosted completion toasts can be replaced by native notifications. -->
<div
	class="portico-chat-completion-toast flex gap-2.5 text-left min-w-[var(--width)] w-full dark:bg-gray-850 dark:text-white bg-white text-black border border-gray-100 dark:border-gray-800 rounded-3xl px-4 py-3.5 cursor-pointer select-none"
	on:dragstart|preventDefault
	on:pointerdown={onPointerDown}
	on:pointermove={onPointerMove}
	on:pointerup={onPointerUp}
	on:pointercancel={() => (moved = true)}
	on:keydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			clickHandler();
		}
	}}
>
	<div class="shrink-0 self-top -translate-y-0.5">
		<img src="{WEBUI_BASE_URL}/static/favicon.png" alt="favicon" class="size-6 rounded-full" />
	</div>

	<div>
		{#if title}
			<div class="text-[13px] font-medium mb-0.5 line-clamp-1">{title}</div>
		{/if}

		<div class="line-clamp-2 text-xs self-center dark:text-gray-300 font-normal">
			{@html DOMPurify.sanitize(marked(content))}
		</div>
	</div>
</div>
