const test = require("node:test");
const assert = require("node:assert/strict");

const {
  boundsIntersectWorkArea,
  computeGuidedSetupResizeBounds,
  getCenteredBounds,
} = require("./guided-setup-window-bounds");

test("computeGuidedSetupResizeBounds preserves the current window center on the active display", () => {
  const workArea = { x: 1440, y: 32, width: 1728, height: 1078 };
  const currentBounds = { x: 1910, y: 180, width: 980, height: 720 };

  const resized = computeGuidedSetupResizeBounds(
    currentBounds,
    { width: 1180, height: 1080 },
    workArea,
  );

  assert.equal(boundsIntersectWorkArea(currentBounds, workArea), true);
  assert.deepEqual(resized, {
    x: 1810,
    y: 32,
    width: 1180,
    height: 1078,
  });
  assert.notDeepEqual(resized, getCenteredBounds({ width: 1180, height: 1080 }, workArea));
});

test("computeGuidedSetupResizeBounds recenters when current bounds are off-screen for the display", () => {
  const workArea = { x: 1440, y: 32, width: 1728, height: 1078 };
  const currentBounds = { x: 3320, y: 180, width: 420, height: 420 };

  const resized = computeGuidedSetupResizeBounds(
    currentBounds,
    { width: 1180, height: 820 },
    workArea,
  );

  assert.equal(boundsIntersectWorkArea(currentBounds, workArea), false);
  assert.deepEqual(resized, getCenteredBounds({ width: 1180, height: 820 }, workArea));
});
