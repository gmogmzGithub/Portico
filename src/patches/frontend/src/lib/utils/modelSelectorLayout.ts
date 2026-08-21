// Pure layout math for the model selector popover (Chat UI layer).
//
// Extracted from ModelSelector/Selector.svelte's updateModelSelectorAvailableSpace
// + its modelSelectorContentStyle reactive so the constraint behavior is unit
// testable in plain Node (tests/test_frontend_model_selection.cjs) without a
// DOM. Selector.svelte passes its own constants in, so the component remains
// the single place those tunables are declared.

export interface ModelSelectorLayoutInput {
	composer: boolean;
	isMobile: boolean;
	viewportWidth: number;
	/** Trigger's viewport-relative left edge, or null when unmeasurable. */
	triggerLeft: number | null;
	/** Trigger's viewport-relative top edge, or null when unmeasurable. */
	triggerTop: number | null;
	/**
	 * The popover's natural width in px (composer fixed width or the class-name
	 * width map entry). null means "no known natural width" — the popover fits
	 * whatever space is available and is never constrained.
	 */
	desiredWidthPx: number | null;
	viewportPaddingPx?: number;
	minConstrainedWidthPx?: number;
	sideGuideMinWidthPx?: number;
	composerSideOffsetPx?: number;
}

export interface ModelSelectorLayout {
	availableWidthPx: number;
	constrainedWidthPx: number | null;
	constrainedMaxHeightPx: number | null;
	shouldStackModelGuide: boolean;
	contentStyle: string;
}

const DEFAULT_VIEWPORT_PADDING_PX = 16;
const DEFAULT_MIN_CONSTRAINED_WIDTH_PX = 320;
const DEFAULT_SIDE_GUIDE_MIN_WIDTH_PX = 1040;
const DEFAULT_COMPOSER_SIDE_OFFSET_PX = 12;

/** Inline style string for the popover: width/max-height only when constrained. */
export const buildModelSelectorContentStyle = (
	constrainedWidthPx: number | null,
	constrainedMaxHeightPx: number | null
): string =>
	[
		constrainedWidthPx ? `width: ${constrainedWidthPx}px;` : '',
		constrainedMaxHeightPx ? `max-height: ${constrainedMaxHeightPx}px;` : ''
	]
		.filter(Boolean)
		.join(' ');

export const computeModelSelectorLayout = (
	input: ModelSelectorLayoutInput
): ModelSelectorLayout => {
	const {
		composer,
		isMobile,
		viewportWidth,
		triggerLeft,
		triggerTop,
		desiredWidthPx,
		viewportPaddingPx = DEFAULT_VIEWPORT_PADDING_PX,
		minConstrainedWidthPx = DEFAULT_MIN_CONSTRAINED_WIDTH_PX,
		sideGuideMinWidthPx = DEFAULT_SIDE_GUIDE_MIN_WIDTH_PX,
		composerSideOffsetPx = DEFAULT_COMPOSER_SIDE_OFFSET_PX
	} = input;

	// Desktop composer picker opens upward unconditionally — cap its height to
	// EXACTLY the space above the trigger (never more) so the upward popover
	// can't overflow the top of the viewport; the list scrolls inside instead.
	// Mobile keeps the default bottom+flip behavior.
	let constrainedMaxHeightPx: number | null = null;
	if (composer && !isMobile && typeof triggerTop === 'number') {
		const availableAbove = Math.floor(triggerTop - composerSideOffsetPx - viewportPaddingPx);
		constrainedMaxHeightPx = availableAbove > 0 ? availableAbove : null;
	}

	// Space the popover may occupy: the composer centers over the viewport
	// (padding on both sides); the navbar picker extends rightward from its
	// trigger (padding on the right only).
	const availableWidthPx = Math.max(
		minConstrainedWidthPx,
		composer
			? viewportWidth - viewportPaddingPx * 2
			: (typeof triggerLeft === 'number' ? viewportWidth - triggerLeft : viewportWidth) -
					viewportPaddingPx
	);
	const resolvedDesiredWidthPx = desiredWidthPx ?? availableWidthPx;
	const shouldConstrain = resolvedDesiredWidthPx > availableWidthPx;

	const constrainedWidthPx = shouldConstrain ? Math.floor(availableWidthPx) : null;
	const shouldStackModelGuide = shouldConstrain && availableWidthPx < sideGuideMinWidthPx;

	return {
		availableWidthPx,
		constrainedWidthPx,
		constrainedMaxHeightPx,
		shouldStackModelGuide,
		contentStyle: buildModelSelectorContentStyle(constrainedWidthPx, constrainedMaxHeightPx)
	};
};
