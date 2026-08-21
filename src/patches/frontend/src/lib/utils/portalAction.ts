// Svelte action that re-parents a DOM node into a target element while the
// owning component stays mounted — used by the multi-chat tiling view to move
// live Chat instances between layout slots (and the primary composer into the
// shared bottom bar) WITHOUT destroying component state mid-stream.
export function portalTo(node: HTMLElement, target: HTMLElement | null | undefined) {
	const home = node.parentElement;

	const apply = (nextTarget: HTMLElement | null | undefined) => {
		const destination = nextTarget ?? home;
		if (destination && node.parentElement !== destination) {
			// Re-inserting a subtree resets every descendant's scroll position
			// to 0 (which also breaks chat auto-scroll stickiness) — snapshot
			// and restore the chat scrollers across the move.
			const scrollers = [...node.querySelectorAll('[id^="messages-container"]')].filter(
				(el): el is HTMLElement => el instanceof HTMLElement && el.scrollTop > 0
			);
			const saved = scrollers.map((el) => [el, el.scrollTop, el.scrollLeft] as const);
			destination.appendChild(node);
			for (const [el, top, left] of saved) {
				el.scrollTop = top;
				el.scrollLeft = left;
			}
		}
	};

	apply(target);

	return {
		update: apply,
		destroy() {
			node.remove();
		}
	};
}
