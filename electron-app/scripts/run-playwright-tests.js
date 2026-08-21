const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PLAYWRIGHT_TEST_SUFFIXES = [
  ".spec.js",
  ".spec.cjs",
  ".spec.mjs",
  ".spec.ts",
  ".playwright.test.js",
  ".playwright.test.cjs",
  ".playwright.test.mjs",
  ".playwright.test.ts",
  ".pw.test.js",
  ".pw.test.cjs",
  ".pw.test.mjs",
  ".pw.test.ts",
];

function normalizeRelativePath(value) {
  return String(value || "").split(path.sep).join("/");
}

function matchesPlaywrightTestPattern(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  return PLAYWRIGHT_TEST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function discoverPlaywrightTestFiles(rootDir) {
  const testsRoot = path.join(rootDir, "tests");
  if (!fs.existsSync(testsRoot)) {
    return [];
  }

  const results = [];
  const stack = [testsRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "playwright-report") {
        continue;
      }

      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      const relativePath = normalizeRelativePath(path.relative(rootDir, absolutePath));
      if (matchesPlaywrightTestPattern(relativePath)) {
        results.push(relativePath);
      }
    }
  }

  return results.sort();
}

function run() {
  const rootDir = path.resolve(__dirname, "..");
  const testFiles = discoverPlaywrightTestFiles(rootDir);
  if (testFiles.length === 0) {
    console.log("No Playwright spec files found under electron-app/tests; skipping.");
    return 0;
  }

  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(
    npxCommand,
    ["playwright", "test", ...process.argv.slice(2)],
    {
      cwd: rootDir,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }

  return typeof result.status === "number" ? result.status : 1;
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = {
  PLAYWRIGHT_TEST_SUFFIXES,
  discoverPlaywrightTestFiles,
  matchesPlaywrightTestPattern,
};
