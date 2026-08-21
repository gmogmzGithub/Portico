const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getGuidedSetupStageWindowOptions,
} = require("../renderer/views/guided-setup-stage-window");

test("getGuidedSetupStageWindowOptions returns explicit heights for guided setup stages", () => {
  assert.deepEqual(getGuidedSetupStageWindowOptions("oauth"), {
    targetHeight: 860,
  });
  assert.deepEqual(getGuidedSetupStageWindowOptions("configuration"), {
    targetHeight: 1080,
  });
  assert.deepEqual(getGuidedSetupStageWindowOptions("finalize"), {
    targetHeight: 800,
  });
  assert.deepEqual(
    getGuidedSetupStageWindowOptions("server-selection", {
      onboardingMode: "power",
    }),
    { targetHeight: 880 },
  );
  assert.equal(
    getGuidedSetupStageWindowOptions("server-selection", {
      onboardingMode: "basic",
    }),
    null,
  );
  assert.equal(getGuidedSetupStageWindowOptions("welcome"), null);
});

test("hello declares an explicit width so the two mode cards stay side by side", () => {
  // Regression guard: hello had no entry, so a 'full' launch (which jumps
  // straight here, skipping the welcome screen's resize) left the window at its
  // 740px birth width and the cards collapsed to a single stacked column.
  assert.deepEqual(getGuidedSetupStageWindowOptions("hello"), {
    targetWidth: 1180,
    targetHeight: 820,
  });
});
