const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("mcp-servers renderer uses localhost for local API calls", () => {
  const filePath = path.join(
    __dirname,
    "..",
    "renderer",
    "components",
    "mcp-servers.js",
  );
  const source = fs.readFileSync(filePath, "utf8");

  assert.match(source, /LOCAL_API_BASE_URL\s*=\s*"http:\/\/localhost:9876"/);
  assert.doesNotMatch(source, /http:\/\/127\.0\.0\.1:9876\/api\/server-readiness/);
  assert.doesNotMatch(source, /http:\/\/127\.0\.0\.1:9876\/api\/restart-mcp/);
});
