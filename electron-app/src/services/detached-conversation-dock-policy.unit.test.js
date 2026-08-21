const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DETACHED_WINDOW_RETURN_ARM_DELAY_MS,
  DETACHED_WINDOW_RETURN_DWELL_MS,
  evaluateDetachedConversationDockReturn,
} = require('./detached-conversation-dock-policy');

const initialBounds = { x: 100, y: 100, width: 900, height: 700 };
const dropTargetBounds = { x: 320, y: 40, width: 640, height: 56 };

function hotzoneFor(bounds) {
  return {
    x: bounds.x + 48,
    y: bounds.y,
    width: bounds.width - 96,
    height: 92,
  };
}

function evaluate(overrides = {}) {
  const nowMs =
    overrides.nowMs ??
    DETACHED_WINDOW_RETURN_ARM_DELAY_MS + DETACHED_WINDOW_RETURN_DWELL_MS + 10;
  const currentBounds =
    overrides.currentBounds ?? { x: 330, y: 38, width: 900, height: 700 };
  return evaluateDetachedConversationDockReturn({
    initialBounds,
    currentBounds,
    hotzoneBounds: overrides.hotzoneBounds ?? hotzoneFor(currentBounds),
    dropTargetBounds: overrides.dropTargetBounds ?? dropTargetBounds,
    createdAtMs: 0,
    hoverStartedAtMs:
      overrides.hoverStartedAtMs === undefined ? 900 : overrides.hoverStartedAtMs,
    nowMs,
  });
}

test('slight detached-window drag does not arm docking', () => {
  const currentBounds = { x: 125, y: 122, width: 900, height: 700 };
  const result = evaluate({
    currentBounds,
    hotzoneBounds: hotzoneFor(currentBounds),
  });

  assert.equal(result.eligible, false);
  assert.equal(result.canAttach, false);
  assert.ok(result.dragDistance < 80);
});

test('weak edge overlap does not arm docking', () => {
  const result = evaluate({
    hotzoneBounds: { x: 950, y: 40, width: 40, height: 92 },
  });

  assert.equal(result.strongOverlap, false);
  assert.equal(result.eligible, false);
  assert.equal(result.canAttach, false);
});

test('strong overlap requires dwell before docking', () => {
  const result = evaluate({
    hoverStartedAtMs: DETACHED_WINDOW_RETURN_ARM_DELAY_MS,
    nowMs: DETACHED_WINDOW_RETURN_ARM_DELAY_MS + 200,
  });

  assert.equal(result.strongOverlap, true);
  assert.equal(result.eligible, true);
  assert.equal(result.canAttach, false);
  assert.equal(result.remainingDwellMs, DETACHED_WINDOW_RETURN_DWELL_MS - 200);
});

test('deliberate tab-strip hover can dock after arm delay and dwell', () => {
  const result = evaluate({
    hoverStartedAtMs: DETACHED_WINDOW_RETURN_ARM_DELAY_MS,
    nowMs: DETACHED_WINDOW_RETURN_ARM_DELAY_MS + DETACHED_WINDOW_RETURN_DWELL_MS,
  });

  assert.equal(result.strongOverlap, true);
  assert.equal(result.eligible, true);
  assert.equal(result.canAttach, true);
  assert.equal(result.remainingDwellMs, 0);
});
