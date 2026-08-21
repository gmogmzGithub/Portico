import assert from 'node:assert/strict';
import test from 'node:test';

import {
	computePageCuts,
	mapCssBoxesToCanvas
} from '../src/patches/frontend/src/lib/utils/pdf-pagination.mjs';

const PAGE = 1000;

const assertInvariants = (cuts, totalHeight, pageHeight) => {
	assert.ok(cuts.length >= 1);
	assert.equal(cuts[cuts.length - 1], totalHeight);
	let prev = 0;
	for (const cut of cuts) {
		assert.ok(cut > prev, `cuts must strictly increase (${cut} after ${prev})`);
		assert.ok(cut - prev <= pageHeight, `slice ${cut - prev} exceeds page height`);
		prev = cut;
	}
};

test('content shorter than one page produces a single cut at totalHeight', () => {
	assert.deepEqual(computePageCuts({ totalHeight: 400, pageHeight: PAGE }), [400]);
});

test('content exactly one page tall produces a single cut', () => {
	assert.deepEqual(computePageCuts({ totalHeight: PAGE, pageHeight: PAGE }), [PAGE]);
});

test('without boxes, cuts land at fixed page offsets', () => {
	assert.deepEqual(computePageCuts({ totalHeight: 3500, pageHeight: PAGE }), [
		1000, 2000, 3000, 3500
	]);
});

test('a box straddling the ideal cut moves the cut to the gap above it', () => {
	const cuts = computePageCuts({
		totalHeight: 2500,
		pageHeight: PAGE,
		boxes: [{ top: 950, bottom: 1100 }]
	});
	assert.equal(cuts[0], 950);
	// The box lands whole on the next page: no cut falls inside (950, 1100).
	for (const cut of cuts) {
		assert.ok(cut <= 950 || cut >= 1100, `cut ${cut} splits the box`);
	}
	assertInvariants(cuts, 2500, PAGE);
});

test('minimum-progress guard falls back to a hard cut for very early straddlers', () => {
	// Straddler top is only 10% into the page: honoring it would make a
	// pathologically short page, so the ideal offset wins.
	const cuts = computePageCuts({
		totalHeight: 2500,
		pageHeight: PAGE,
		boxes: [{ top: 100, bottom: 1100 }]
	});
	assert.equal(cuts[0], 1000);
});

test('boxes taller than a page are ignored', () => {
	const cuts = computePageCuts({
		totalHeight: 3000,
		pageHeight: PAGE,
		boxes: [{ top: 200, bottom: 1800 }]
	});
	assert.equal(cuts[0], 1000);
	assertInvariants(cuts, 3000, PAGE);
});

test('boxes that only touch the ideal cut do not move it', () => {
	const cuts = computePageCuts({
		totalHeight: 2500,
		pageHeight: PAGE,
		boxes: [
			{ top: 900, bottom: 1000 },
			{ top: 1000, bottom: 1100 }
		]
	});
	assert.equal(cuts[0], 1000);
});

test('with nested straddlers the earliest top wins', () => {
	const cuts = computePageCuts({
		totalHeight: 2500,
		pageHeight: PAGE,
		boxes: [
			{ top: 900, bottom: 1200 },
			{ top: 950, bottom: 1050 }
		]
	});
	assert.equal(cuts[0], 900);
});

test('chained straddlers: the cut walks up past overlapping boxes', () => {
	// Box A straddles the ideal (1000); its top (950) falls inside box B,
	// so the cut must walk up again to B's top (880).
	const cuts = computePageCuts({
		totalHeight: 2500,
		pageHeight: PAGE,
		boxes: [
			{ top: 950, bottom: 1100 },
			{ top: 880, bottom: 980 }
		]
	});
	assert.equal(cuts[0], 880);
	assertInvariants(cuts, 2500, PAGE);
});

test('an adjusted cut shifts the next page ideal (cascade)', () => {
	const cuts = computePageCuts({
		totalHeight: 3000,
		pageHeight: PAGE,
		boxes: [{ top: 900, bottom: 1100 }]
	});
	assert.equal(cuts[0], 900);
	// Next ideal is 1900, no straddler there, so the second cut is 1900.
	assert.equal(cuts[1], 1900);
	assertInvariants(cuts, 3000, PAGE);
});

test('fuzz: invariants hold over many random boxes', () => {
	// Deterministic LCG so failures reproduce.
	let seed = 42;
	const rand = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};

	const totalHeight = 10 * PAGE + 137;
	const boxes = Array.from({ length: 200 }, () => {
		const top = Math.floor(rand() * totalHeight);
		const height = 1 + Math.floor(rand() * PAGE * 1.5);
		return { top, bottom: top + height };
	});

	const cuts = computePageCuts({ totalHeight, pageHeight: PAGE, boxes });
	assertInvariants(cuts, totalHeight, PAGE);

	// A cut either splits no keepable (page-fitting) box, or is a hard cut at
	// the ideal offset because the min-progress guard bailed out.
	const keepable = boxes.filter((b) => b.bottom - b.top <= PAGE);
	let offset = 0;
	for (const cut of cuts) {
		const splitsSomething = keepable.some((box) => cut > box.top && cut < box.bottom);
		if (splitsSomething && cut !== totalHeight) {
			assert.equal(cut, offset + PAGE, `non-hard cut ${cut} splits a keepable box`);
		}
		offset = cut;
	}
});

test('invalid heights throw TypeError', () => {
	assert.throws(() => computePageCuts({ totalHeight: 0, pageHeight: PAGE }), TypeError);
	assert.throws(() => computePageCuts({ totalHeight: NaN, pageHeight: PAGE }), TypeError);
	assert.throws(() => computePageCuts({ totalHeight: 100, pageHeight: 0 }), TypeError);
	assert.throws(() => computePageCuts({ totalHeight: 100, pageHeight: -5 }), TypeError);
});

test('malformed boxes are filtered silently', () => {
	const cuts = computePageCuts({
		totalHeight: 2500,
		pageHeight: PAGE,
		boxes: [
			null,
			{ top: 'x', bottom: 100 },
			{ top: 500, bottom: 400 },
			{ top: NaN, bottom: NaN }
		]
	});
	assert.deepEqual(cuts, [1000, 2000, 2500]);
});

test('mapCssBoxesToCanvas scales, rounds, and drops empty boxes', () => {
	const mapped = mapCssBoxesToCanvas(
		[
			{ top: 10.4, bottom: 20.6 },
			{ top: 5, bottom: 5 },
			{ top: 8, bottom: 7 },
			null,
			{ top: 1, bottom: 2 }
		],
		2
	);
	assert.deepEqual(mapped, [
		{ top: 21, bottom: 41 },
		{ top: 2, bottom: 4 }
	]);
	assert.throws(() => mapCssBoxesToCanvas([], 0), TypeError);
});
