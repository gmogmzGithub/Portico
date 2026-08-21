/**
 * PORTICO PATCH (landing starfield): deterministic star-data for the dark-mode
 * landing-page cosmic backdrop (LandingStarfield.svelte).
 *
 * Baked-field philosophy cloned from the Electron loading screen
 * (electron-app/src/renderer/views/loading.html): positions, sizes, opacities,
 * durations and delays are fixed data, generated once at module scope from a
 * seeded PRNG — the SVG paints once and only CSS animates it. Plain .mjs with
 * zero imports so node tests can import it directly (same pattern as
 * work-activity-summary.mjs).
 */

export const STARFIELD_SEED = 20260801;

export const STARFIELD_VIEWBOX = Object.freeze({ width: 1200, height: 800 });

/** 4-point diamond from loading.html's sparkle stars (sp-core). */
export const SPARKLE_PATH =
	'M0 -7 L1.4 -1.4 L7 0 L1.4 1.4 L0 7 L-1.4 1.4 L-7 0 L-1.4 -1.4 Z';

export const STARFIELD_SPEC = Object.freeze({
	statics: Object.freeze({ count: 90, radius: [0.5, 1.6], opacity: [0.25, 0.65], warmChance: 0.12 }),
	// Event stars: each rests at a baked `rest` opacity for most of its long
	// cycle, then performs one brief action (see the portico-star-* keyframes).
	// A mostly-still sky is what makes the occasional event read as an event
	// — the old short-cycle continuous pulsing averaged out to invisible
	// shimmer. With 18 fade stars on 16-28s cycles, ~2-3 are mid-fade at any
	// moment.
	twinkles: Object.freeze({
		count: 18,
		radius: [0.9, 1.9],
		warmChance: 0.15,
		duration: [16, 28],
		rest: [0.45, 0.8]
	}),
	// The big diamonds are the most visible objects in the field, so their
	// event is the gentlest: a soft swell once per cycle.
	sparkles: Object.freeze({
		count: 5,
		scale: [0.75, 1.15],
		inset: 30,
		duration: [18, 30],
		rest: [0.4, 0.6]
	}),
	// The quick twirl occupies the final 8% of the cycle (see portico-star-spin
	// keyframes), so 14-24s cycles yield a 1.1-1.9s spin.
	spinners: Object.freeze({
		count: 6,
		scale: [0.55, 0.85],
		inset: 30,
		duration: [14, 24],
		rest: [0.45, 0.65]
	}),
	shooters: Object.freeze({
		count: 2,
		tailLength: [70, 110],
		distance: [320, 420],
		angle: [24, 32], // degrees below horizontal; second shooter is mirrored to travel down-left
		durations: [19, 27],
		delays: [-7, -15]
	})
});

/** mulberry32 — tiny deterministic PRNG, uniform in [0, 1). */
export function createSeededRandom(seed) {
	let t = seed >>> 0;
	return function () {
		t += 0x6d2b79f5;
		let r = Math.imul(t ^ (t >>> 15), 1 | t);
		r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

export function generateStarfield(seed = STARFIELD_SEED) {
	const rand = createSeededRandom(seed);
	const pick = ([lo, hi]) => lo + rand() * (hi - lo);
	const { width, height } = STARFIELD_VIEWBOX;

	// Stratified initial phase: star i starts (i + jitter)/count of the way
	// through its own cycle, so event onsets spread evenly across the
	// timeline instead of clumping (subtle and controlled, never chaotic);
	// the varied durations then drift the onsets organically so the pattern
	// never repeats.
	const stratifiedDelay = (index, count, duration) =>
		round1((-(index + rand() * 0.9) / count) * duration);

	const statics = Array.from({ length: STARFIELD_SPEC.statics.count }, () => ({
		x: round1(rand() * width),
		y: round1(rand() * height),
		r: round1(pick(STARFIELD_SPEC.statics.radius)),
		opacity: round1(pick(STARFIELD_SPEC.statics.opacity)),
		warm: rand() < STARFIELD_SPEC.statics.warmChance
	}));

	const twinkles = Array.from({ length: STARFIELD_SPEC.twinkles.count }, (_, i) => {
		const duration = round1(pick(STARFIELD_SPEC.twinkles.duration));
		return {
			x: round1(rand() * width),
			y: round1(rand() * height),
			r: round1(pick(STARFIELD_SPEC.twinkles.radius)),
			warm: rand() < STARFIELD_SPEC.twinkles.warmChance,
			rest: round2(pick(STARFIELD_SPEC.twinkles.rest)),
			duration,
			delay: stratifiedDelay(i, STARFIELD_SPEC.twinkles.count, duration)
		};
	});

	const diamondField = (spec) =>
		Array.from({ length: spec.count }, (_, i) => {
			const duration = round1(pick(spec.duration));
			return {
				x: round1(spec.inset + rand() * (width - 2 * spec.inset)),
				y: round1(spec.inset + rand() * (height - 2 * spec.inset)),
				scale: round1(pick(spec.scale)),
				rest: round2(pick(spec.rest)),
				duration,
				delay: stratifiedDelay(i, spec.count, duration)
			};
		});

	const sparkles = diamondField(STARFIELD_SPEC.sparkles);
	const spinners = diamondField(STARFIELD_SPEC.spinners);

	const shooters = Array.from({ length: STARFIELD_SPEC.shooters.count }, (_, i) => {
		const spec = STARFIELD_SPEC.shooters;
		const baseAngle = round1(pick(spec.angle));
		// Shooter 0 streaks down-right; shooter 1 is mirrored (down-left) so the
		// two never read as copies of each other.
		const angle = i % 2 === 0 ? baseAngle : round1(180 - baseAngle);
		const distance = round1(pick(spec.distance));
		const radians = (angle * Math.PI) / 180;
		const dx = round1(Math.cos(radians) * distance);
		const dy = round1(Math.sin(radians) * distance);
		// Start where the full travel stays inside the viewBox, biased to the
		// upper half of the sky so streaks pass above the landing content.
		const minX = dx >= 0 ? 30 : 30 - dx;
		const maxX = dx >= 0 ? width - 30 - dx : width - 30;
		const maxY = Math.min(height * 0.55, height - 30 - dy);
		return {
			x: round1(minX + rand() * (maxX - minX)),
			y: round1(30 + rand() * (maxY - 30)),
			angle,
			distance,
			dx,
			dy,
			tailLength: round1(pick(spec.tailLength)),
			duration: spec.durations[i],
			delay: spec.delays[i]
		};
	});

	return Object.freeze({
		statics: Object.freeze(statics),
		twinkles: Object.freeze(twinkles),
		sparkles: Object.freeze(sparkles),
		spinners: Object.freeze(spinners),
		shooters: Object.freeze(shooters)
	});
}

/** The one field the app renders — generated once, frozen. */
export const STARFIELD = generateStarfield(STARFIELD_SEED);
