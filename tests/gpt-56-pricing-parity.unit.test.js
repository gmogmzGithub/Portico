const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

function assertNestedTestRan(stdout, title) {
  const resultLine = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("ok ") && line.includes(`- ${title}`));
  assert.ok(resultLine, `nested test did not report a result: ${title}`);
  assert.doesNotMatch(resultLine, /# SKIP/);
}

test("default gate exercises GPT-5.6 frontend and Electron pricing parity", () => {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern=GPT-5.6",
      path.join(ROOT, "tests/test_frontend_model_selection.cjs"),
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: childEnv,
    },
  );

  assert.equal(
    result.status,
    0,
    `GPT-5.6 pricing parity failed:\n${result.stdout}\n${result.stderr}`,
  );
  assertNestedTestRan(
    result.stdout,
    "Rust, frontend, and Electron GPT-5.6 pricing share one rate fixture",
  );
  assertNestedTestRan(
    result.stdout,
    "GPT-5.6 costs use base rates through 272K and high-context rates above it",
  );
});
