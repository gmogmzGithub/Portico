// Break-aware pagination for the stylized chat PDF export.
// Pure canvas-pixel geometry so the slicing logic is testable in Node.

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Scale CSS-pixel boxes into canvas pixels.
 * @param {Array<{top: number, bottom: number}>} boxes
 * @param {number} ratio canvas px per CSS px
 * @returns {Array<{top: number, bottom: number}>}
 */
export function mapCssBoxesToCanvas(boxes = [], ratio = 1) {
	if (!isFiniteNumber(ratio) || ratio <= 0) {
		throw new TypeError(`mapCssBoxesToCanvas: invalid ratio ${ratio}`);
	}

	return boxes
		.filter((box) => box && isFiniteNumber(box.top) && isFiniteNumber(box.bottom))
		.map((box) => ({
			top: Math.round(box.top * ratio),
			bottom: Math.round(box.bottom * ratio)
		}))
		.filter((box) => box.bottom > box.top);
}

/**
 * Compute page cut positions for a tall canvas so that cuts fall in the
 * gaps between atomic content boxes instead of through them.
 *
 * @param {{
 *   totalHeight: number,
 *   pageHeight: number,
 *   boxes?: Array<{top: number, bottom: number}>,
 *   minSliceRatio?: number
 * }} opts all values in canvas px
 * @returns {number[]} ascending cut positions; the last cut equals totalHeight
 */
export function computePageCuts({ totalHeight, pageHeight, boxes = [], minSliceRatio = 0.2 }) {
	if (!isFiniteNumber(totalHeight) || totalHeight <= 0) {
		throw new TypeError(`computePageCuts: invalid totalHeight ${totalHeight}`);
	}
	if (!isFiniteNumber(pageHeight) || pageHeight <= 0) {
		throw new TypeError(`computePageCuts: invalid pageHeight ${pageHeight}`);
	}

	const clampedRatio = isFiniteNumber(minSliceRatio) ? Math.min(Math.max(minSliceRatio, 0), 0.9) : 0.2;
	const minSlice = clampedRatio * pageHeight;

	// Boxes taller than a page can never be kept whole; dropping them up front
	// makes nearby cuts fall back to the ideal offset (or be guided by the
	// box's smaller descendants, which are collected too).
	const atomicBoxes = boxes.filter(
		(box) =>
			box &&
			isFiniteNumber(box.top) &&
			isFiniteNumber(box.bottom) &&
			box.bottom > box.top &&
			box.bottom - box.top <= pageHeight
	);

	const cuts = [];
	let offset = 0;

	while (totalHeight - offset > pageHeight) {
		const ideal = offset + pageHeight;

		// Walk the cut upward until it sits in a gap: the top of one straddler
		// can itself fall inside another box, so iterate to a fixed point.
		// Strict comparisons: a box that merely touches the cut is not split by it.
		let cut = ideal;
		for (;;) {
			const straddlers = atomicBoxes.filter((box) => box.top < cut && box.bottom > cut);
			if (straddlers.length === 0) {
				break;
			}
			const candidate = Math.floor(Math.min(...straddlers.map((box) => box.top)));
			if (candidate - offset < minSlice) {
				// Honoring the gap would leave a pathologically short page;
				// give up and hard-cut at the ideal offset instead.
				cut = ideal;
				break;
			}
			cut = candidate;
		}

		cuts.push(cut);
		offset = cut;
	}

	cuts.push(totalHeight);
	return cuts;
}
