const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  collectSystemInformation,
  macCpuFamily,
  parseDarwinGpuSummary,
} = require("./system-info");

test("system information response shape includes hardware fields", () => {
  const info = collectSystemInformation();
  assert.equal(typeof info.os.platform, "string");
  assert.equal(typeof info.cpu.architecture, "string");
  assert.equal(typeof info.cpu.logical_cores, "number");
  assert.equal(typeof info.memory.total_bytes, "number");
  assert.ok(Array.isArray(info.gpu));
});

test("mac CPU family distinguishes Apple Silicon and Intel", () => {
  assert.equal(macCpuFamily("arm64", "darwin"), "apple_silicon");
  assert.equal(macCpuFamily("x64", "linux"), null);
});

test("Darwin GPU JSON summary is compact and tolerant", () => {
  const parsed = parseDarwinGpuSummary(
    JSON.stringify({
      SPDisplaysDataType: [
        {
          _name: "Apple M3 Max",
          sppci_cores: "40",
          spdisplays_metal: "Supported",
        },
      ],
    }),
  );
  assert.deepEqual(parsed, [
    {
      name: "Apple M3 Max",
      cores: "40",
      vram: null,
      metal: "Supported",
    },
  ]);
  assert.deepEqual(parseDarwinGpuSummary("not-json"), []);
});

test("API server exposes the system-information endpoint", () => {
  const apiSource = fs.readFileSync(path.join(__dirname, "api.js"), "utf8");
  assert.match(apiSource, /\/api\/system-information/);
  assert.match(apiSource, /collectSystemInformation/);
});
