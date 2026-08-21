// Behavioral tests for the OWUI UI callout impression counters (Application
// Support JSON). The contract under test: reads are graceful (missing or
// corrupt state reports zero impressions — the callout shows), increments
// create/update the file.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  OWUI_UI_CALLOUTS_FILENAME,
  readOwuiUiCallouts,
  getOwuiUiCalloutImpressions,
  incrementOwuiUiCalloutCounter,
} = require("./owui-ui-callouts");

const tempUserData = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "owui-ui-callouts-test-"));

test("missing state file reads as zero impressions (callout shows)", () => {
  const userDataPath = tempUserData();
  const result = readOwuiUiCallouts({ userDataPath });
  assert.equal(result.success, true);
  assert.equal(result.exists, false);
  assert.deepEqual(result.data.counters, {});
  assert.equal(
    getOwuiUiCalloutImpressions({ userDataPath, key: "reviewerWorkflowCta" }),
    0,
  );
});

test("corrupt state file reads as zero impressions without throwing", () => {
  const userDataPath = tempUserData();
  fs.writeFileSync(
    path.join(userDataPath, OWUI_UI_CALLOUTS_FILENAME),
    "{not json",
    "utf8",
  );
  const result = readOwuiUiCallouts({ userDataPath });
  assert.equal(result.success, true);
  assert.ok(result.parseError);
  assert.equal(
    getOwuiUiCalloutImpressions({ userDataPath, key: "reviewerWorkflowCta" }),
    0,
  );
});

test("increment creates the file and counts per key", () => {
  const userDataPath = tempUserData();
  const first = incrementOwuiUiCalloutCounter({
    userDataPath,
    key: "reviewerWorkflowCta",
  });
  assert.equal(first.success, true);
  assert.equal(first.impressions, 1);
  incrementOwuiUiCalloutCounter({ userDataPath, key: "reviewerWorkflowCta" });
  const third = incrementOwuiUiCalloutCounter({
    userDataPath,
    key: "reviewerWorkflowCta",
  });
  assert.equal(third.impressions, 3);
  assert.equal(
    getOwuiUiCalloutImpressions({ userDataPath, key: "reviewerWorkflowCta" }),
    3,
  );
  assert.equal(
    getOwuiUiCalloutImpressions({ userDataPath, key: "otherCallout" }),
    0,
  );
});

test("invalid inputs fail closed without touching the filesystem", () => {
  const userDataPath = tempUserData();
  assert.equal(
    incrementOwuiUiCalloutCounter({ userDataPath, key: "" }).success,
    false,
  );
  assert.equal(
    incrementOwuiUiCalloutCounter({ userDataPath: "", key: "x" }).success,
    false,
  );
  assert.equal(
    fs.existsSync(path.join(userDataPath, OWUI_UI_CALLOUTS_FILENAME)),
    false,
  );
});
