const COMPACT_BASE_SCALE = 0.9;

export const setTextScale = (scale) => {
	if (typeof document === 'undefined') {
		return;
	}

	const numericScale = Number(scale);
	const safeScale = Number.isFinite(numericScale) && numericScale > 0 ? numericScale : 1;
	const effectiveScale = Number((safeScale * COMPACT_BASE_SCALE).toFixed(3));

	document.documentElement.style.setProperty('--app-text-scale', `${effectiveScale}`);
};

/** Read the live user-facing scale back from the CSS variable. */
export const getTextScale = (): number | null => {
	if (typeof document === 'undefined') {
		return null;
	}

	const raw = getComputedStyle(document.documentElement)
		.getPropertyValue('--app-text-scale')
		.trim();
	const effective = parseFloat(raw);
	if (!Number.isFinite(effective) || effective <= 0) {
		return null;
	}

	const userScale = parseFloat((effective / COMPACT_BASE_SCALE).toFixed(2));
	return userScale === 1 ? null : userScale;
};
