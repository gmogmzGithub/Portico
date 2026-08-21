// Behavioral tests for the landing-page starfield data module. These assert
// the generated field's contract (counts, bounds, animation windows,
// determinism) — never application source text.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
	STARFIELD,
	STARFIELD_SEED,
	STARFIELD_SPEC,
	STARFIELD_VIEWBOX,
	SPARKLE_PATH,
	generateStarfield
} from '../src/patches/frontend/src/lib/utils/landing-starfield.mjs';

const { width, height } = STARFIELD_VIEWBOX;

const allNumbersFinite = (record) =>
	Object.values(record).every((v) => typeof v === 'boolean' || Number.isFinite(v));

const inRange = (v, [lo, hi]) => v >= lo && v <= hi;

test('generation is deterministic for the fixed seed and varies by seed', () => {
	assert.deepEqual(generateStarfield(STARFIELD_SEED), STARFIELD);
	assert.notDeepEqual(generateStarfield(STARFIELD_SEED + 1), STARFIELD);
});

test('population counts match the spec', () => {
	assert.equal(STARFIELD.statics.length, STARFIELD_SPEC.statics.count);
	assert.equal(STARFIELD.twinkles.length, STARFIELD_SPEC.twinkles.count);
	assert.equal(STARFIELD.sparkles.length, STARFIELD_SPEC.sparkles.count);
	assert.equal(STARFIELD.spinners.length, STARFIELD_SPEC.spinners.count);
	assert.equal(STARFIELD.shooters.length, STARFIELD_SPEC.shooters.count);
});

test('every record is finite and inside the viewBox', () => {
	for (const group of Object.values(STARFIELD)) {
		for (const star of group) {
			assert.ok(allNumbersFinite(star), `non-finite field in ${JSON.stringify(star)}`);
			assert.ok(star.x >= 0 && star.x <= width, `x out of bounds: ${star.x}`);
			assert.ok(star.y >= 0 && star.y <= height, `y out of bounds: ${star.y}`);
		}
	}
});

test('statics respect radius/opacity ranges', () => {
	for (const s of STARFIELD.statics) {
		assert.ok(inRange(s.r, STARFIELD_SPEC.statics.radius), `radius ${s.r}`);
		assert.ok(inRange(s.opacity, STARFIELD_SPEC.statics.opacity), `opacity ${s.opacity}`);
	}
});

test('twinkles respect ranges and desync delays', () => {
	for (const s of STARFIELD.twinkles) {
		assert.ok(inRange(s.r, STARFIELD_SPEC.twinkles.radius), `radius ${s.r}`);
		assert.ok(inRange(s.duration, STARFIELD_SPEC.twinkles.duration), `duration ${s.duration}`);
		assert.ok(s.delay <= 0 && s.delay >= -s.duration, `delay ${s.delay} vs duration ${s.duration}`);
	}
});

test('event stars rest within spec and spread their onsets evenly', () => {
	for (const [name, spec] of [
		['twinkles', STARFIELD_SPEC.twinkles],
		['sparkles', STARFIELD_SPEC.sparkles],
		['spinners', STARFIELD_SPEC.spinners]
	]) {
		const stars = STARFIELD[name];
		for (const s of stars) {
			assert.ok(inRange(s.rest, spec.rest), `${name} rest ${s.rest}`);
		}

		// Anti-clump contract ("subtle and controlled, not chaotic"): the
		// initial cycle phases cover the timeline with no gap wider than ~2
		// ideal slots, so events overlap occasionally but never all land at
		// once and the sky never goes dead for a whole slot run.
		const phases = stars.map((s) => -s.delay / s.duration).sort((a, b) => a - b);
		const n = phases.length;
		for (const p of phases) {
			assert.ok(p >= 0 && p < 1, `${name} phase ${p}`);
		}
		for (let i = 0; i < n; i++) {
			const gap = i === n - 1 ? phases[0] + 1 - phases[n - 1] : phases[i + 1] - phases[i];
			assert.ok(gap <= 1.9 / n + 0.01, `${name} onset gap ${gap.toFixed(3)}`);
		}
	}
});

test('sparkles and spinners stay inset from the edges with valid cycles', () => {
	for (const [name, spec] of [
		['sparkles', STARFIELD_SPEC.sparkles],
		['spinners', STARFIELD_SPEC.spinners]
	]) {
		for (const s of STARFIELD[name]) {
			assert.ok(
				s.x >= spec.inset && s.x <= width - spec.inset,
				`${name} x ${s.x} violates inset`
			);
			assert.ok(
				s.y >= spec.inset && s.y <= height - spec.inset,
				`${name} y ${s.y} violates inset`
			);
			assert.ok(inRange(s.scale, spec.scale), `${name} scale ${s.scale}`);
			assert.ok(inRange(s.duration, spec.duration), `${name} duration ${s.duration}`);
			assert.ok(s.delay <= 0 && s.delay >= -s.duration, `${name} delay ${s.delay}`);
		}
	}
});

test('shooters travel their stated distance along their stated angle and stay occasional', () => {
	const spec = STARFIELD_SPEC.shooters;
	const [a, b] = STARFIELD.shooters;

	for (const s of STARFIELD.shooters) {
		const hyp = Math.hypot(s.dx, s.dy);
		assert.ok(Math.abs(hyp - s.distance) < 0.5, `hypot ${hyp} vs distance ${s.distance}`);
		assert.ok(inRange(s.distance, spec.distance), `distance ${s.distance}`);
		assert.ok(inRange(s.tailLength, spec.tailLength), `tail ${s.tailLength}`);
		const mirrored = s.angle > 90;
		const normalized = mirrored ? 180 - s.angle : s.angle;
		assert.ok(inRange(normalized, spec.angle), `angle ${s.angle}`);
		assert.ok(s.dy > 0, 'shooters must travel downward');
		// The full travel must stay inside the viewBox (the layer clips, but an
		// off-screen streak would silently waste the effect).
		assert.ok(s.x + s.dx >= 0 && s.x + s.dx <= width, `end x ${s.x + s.dx}`);
		assert.ok(s.y + s.dy >= 0 && s.y + s.dy <= height, `end y ${s.y + s.dy}`);
	}

	// One travels right, the mirrored one travels left, on distinct cycles so
	// streaks never synchronize.
	assert.ok(a.dx > 0 && b.dx < 0, 'expected mirrored trajectories');
	assert.notEqual(a.duration, b.duration);
	assert.notEqual(a.delay, b.delay);
	assert.deepEqual(
		STARFIELD.shooters.map((s) => s.duration),
		[...spec.durations]
	);
});

test('warm-star ratio stays subtle (5-25%)', () => {
	for (const name of ['statics', 'twinkles']) {
		const warm = STARFIELD[name].filter((s) => s.warm).length;
		const ratio = warm / STARFIELD[name].length;
		assert.ok(ratio >= 0.05 && ratio <= 0.25, `${name} warm ratio ${ratio.toFixed(2)}`);
	}
});

test('sparkle path is the loading-screen diamond and the field is frozen', () => {
	assert.match(SPARKLE_PATH, /^M0 -7 /);
	assert.ok(Object.isFrozen(STARFIELD));
	assert.ok(Object.isFrozen(STARFIELD.twinkles));
});
