const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseHostModeValue,
  readHostModeFile,
  readHostModeFileSync,
} = require("./host-mode-state");

test("parseHostModeValue accepts true case-insensitively with whitespace", () => {
  assert.equal(parseHostModeValue("TRUE"), true);
  assert.equal(parseHostModeValue("true"), true);
  assert.equal(parseHostModeValue(" True \n"), true);
  assert.equal(parseHostModeValue("FALSE"), false);
  assert.equal(parseHostModeValue(""), false);
  assert.equal(parseHostModeValue("enabled"), false);
  assert.equal(parseHostModeValue(null), false);
});

test("HOST_MODE readers fail closed on missing files", async () => {
  const syncFs = {
    readFileSync() {
      throw new Error("missing");
    },
  };
  const asyncFs = {
    async readFile() {
      throw new Error("missing");
    },
  };

  assert.equal(readHostModeFileSync("/missing/HOST_MODE", syncFs), false);
  assert.equal(await readHostModeFile("/missing/HOST_MODE", asyncFs), false);
});

test("HOST_MODE readers use tolerant parser", async () => {
  const syncFs = {
    readFileSync() {
      return " true\n";
    },
  };
  const asyncFs = {
    async readFile() {
      return " True\n";
    },
  };

  assert.equal(readHostModeFileSync("/tmp/HOST_MODE", syncFs), true);
  assert.equal(await readHostModeFile("/tmp/HOST_MODE", asyncFs), true);
});
