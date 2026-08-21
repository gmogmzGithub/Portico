const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  resolveRuntimeCostReportingHostDir,
} = require("./runtime-reporting-path");

test("explicit runtime reporting env override wins", () => {
  const result = resolveRuntimeCostReportingHostDir({
    env: {
      PORTICO_COST_REPORTING_HOST_DIR: "  /tmp/custom-reporting  ",
    },
    isPackagedApp: true,
    projectRoot: "/tmp/project-root",
    userDataPath: "/tmp/user-data",
  });

  assert.equal(result, "/tmp/custom-reporting");
});

test("packaged runs write reporting into Application Support", () => {
  const result = resolveRuntimeCostReportingHostDir({
    env: {},
    isPackagedApp: true,
    projectRoot: "/tmp/project-root",
    userDataPath: "/tmp/user-data",
  });

  assert.equal(result, path.join("/tmp/user-data", "reporting"));
});

test("dev runs keep repo-local reporting directory", () => {
  const result = resolveRuntimeCostReportingHostDir({
    env: {},
    isPackagedApp: false,
    projectRoot: "/tmp/project-root",
    userDataPath: "/tmp/user-data",
  });

  assert.equal(result, path.join("/tmp/project-root", "open-webui-data", "reporting"));
});
