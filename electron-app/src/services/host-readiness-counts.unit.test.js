const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const readServiceSource = (name) =>
  fs.readFileSync(path.join(__dirname, name), "utf8");

test("single-server health returns direct OpenAPI tool and path counts", () => {
  const source = readServiceSource("docker-mcp.js");
  const healthSection = source.slice(
    source.indexOf("async function checkSingleServerHealth"),
    source.indexOf("async function runHealthCheckAndBroadcast"),
  );

  assert.match(
    healthSection,
    /const totalPaths = Object\.keys\(openApiSpec\?\.paths \|\| \{\}\)\.length;/,
  );
  assert.match(healthSection, /toolsCount:\s*callableToolNames\.length,/);
  assert.match(healthSection, /totalPaths,/);
});

test("host readiness preserves direct OpenAPI tool and path counts", () => {
  const source = readServiceSource("api.js");
  const readinessFunctionStart = source.indexOf(
    "async function getServerReadinessStatus",
  );
  const hostBranchStart = source.indexOf(
    "if (deploymentType === 'host')",
    readinessFunctionStart,
  );
  const hostBranchEnd = source.indexOf(
    "const aggregatorBaseUrl",
    hostBranchStart,
  );
  assert.ok(readinessFunctionStart >= 0);
  assert.ok(hostBranchStart > readinessFunctionStart);
  assert.ok(hostBranchEnd > hostBranchStart);

  const hostReadinessSection = source.slice(hostBranchStart, hostBranchEnd);

  assert.match(hostReadinessSection, /tools_count:\s*healthResult\?\.toolsCount,/);
  assert.match(hostReadinessSection, /total_paths:\s*healthResult\?\.totalPaths,/);
});
