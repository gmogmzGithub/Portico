// Selected-first row order for the capability picker popover, ported from the
// Electron-side agents.js `orderCapabilityOptionsForOpen`: already-selected
// rows surface at the top (keeping their relative catalog order), unselected
// rows follow in catalog order. Callers compute this ONCE per popover open —
// toggling a row must not reshuffle the list under the pointer — and recompute
// on the next open. Kept dependency-free so tests can import it directly.

export const orderCapabilityOptionsForOpen = (options, selectedIds) => {
	const list = Array.isArray(options) ? options : [];
	const selected = new Set((selectedIds ?? []).filter(Boolean));
	if (!selected.size) return list;
	const top = [];
	const rest = [];
	for (const option of list) {
		(selected.has(option?.id) ? top : rest).push(option);
	}
	if (!top.length) return list;
	return [...top, ...rest];
};
