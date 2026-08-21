const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  discoverPlaywrightTestFiles,
  matchesPlaywrightTestPattern,
} = require("../scripts/run-playwright-tests.js");

test("matchesPlaywrightTestPattern only accepts dedicated Playwright naming", () => {
  assert.equal(matchesPlaywrightTestPattern("tests/app.spec.js"), true);
  assert.equal(matchesPlaywrightTestPattern("tests/app.playwright.test.ts"), true);
  assert.equal(matchesPlaywrightTestPattern("tests/app.pw.test.mjs"), true);
  assert.equal(matchesPlaywrightTestPattern("tests/app.test.js"), false);
  assert.equal(matchesPlaywrightTestPattern("tests/app.unit.test.js"), false);
});

test("discoverPlaywrightTestFiles ignores node tests and reporting artifacts", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-test-discovery-"));
  try {
    fs.mkdirSync(path.join(rootDir, "tests", "nested"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "tests", "playwright-report"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "tests", "app.spec.js"), "");
    fs.writeFileSync(path.join(rootDir, "tests", "nested", "flow.playwright.test.ts"), "");
    fs.writeFileSync(path.join(rootDir, "tests", "backend-events.test.js"), "");
    fs.writeFileSync(path.join(rootDir, "tests", "playwright-report", "ignored.spec.js"), "");

    assert.deepEqual(discoverPlaywrightTestFiles(rootDir), [
      "tests/app.spec.js",
      "tests/nested/flow.playwright.test.ts",
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
