const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  LEGACY_GATEWAY_INSPECT_TIMEOUT_MS,
  collectAppOwnedGatewayReportingRoots,
  collectRuntimeReportingCleanupRoots,
  extractAppOwnedGatewayReportingBinds,
  removeLegacyRequestPayloadsFromRoots,
  resolveRuntimeCostReportingHostDir,
} = require("./runtime-reporting-path");

function gatewayInspection(root, overrides = {}) {
  return {
    Config: {
      Labels: {
        "com.docker.compose.project": "portico",
        "com.docker.compose.service": "llm-gateway",
      },
    },
    Mounts: [
      {
        Type: "bind",
        Source: root,
        Destination: "/app/reporting",
      },
    ],
    ...overrides,
  };
}

test("explicit runtime reporting env override wins", () => {
  assert.equal(
    resolveRuntimeCostReportingHostDir({
      env: { PORTICO_COST_REPORTING_HOST_DIR: "  /tmp/custom-reporting  " },
      isPackagedApp: true,
      projectRoot: "/tmp/project-root",
      userDataPath: "/tmp/user-data",
    }),
    "/tmp/custom-reporting",
  );
});

test("packaged and dev runs use their app-managed reporting roots", () => {
  assert.equal(
    resolveRuntimeCostReportingHostDir({
      env: {},
      isPackagedApp: true,
      projectRoot: "/tmp/project-root",
      userDataPath: "/tmp/user-data",
    }),
    path.join("/tmp/user-data", "reporting"),
  );
  assert.equal(
    resolveRuntimeCostReportingHostDir({
      env: {},
      isPackagedApp: false,
      projectRoot: "/tmp/project-root",
      userDataPath: "/tmp/user-data",
    }),
    path.join("/tmp/project-root", "open-webui-data", "reporting"),
  );
});

test("cleanup roots include override, Application Support, and managed runtime once", () => {
  assert.deepEqual(
    collectRuntimeReportingCleanupRoots({
      env: { PORTICO_COST_REPORTING_HOST_DIR: "/tmp/custom-reporting" },
      isPackagedApp: true,
      projectRoot: "/tmp/project-root",
      userDataPath: "/tmp/user-data",
    }),
    [
      "/tmp/custom-reporting",
      path.join("/tmp/user-data", "reporting"),
      path.join("/tmp/project-root", "open-webui-data", "reporting"),
    ],
  );
  assert.deepEqual(
    collectRuntimeReportingCleanupRoots({
      env: {},
      isPackagedApp: true,
      projectRoot: "/tmp/project-root",
      userDataPath: "/tmp/user-data",
    }),
    [
      path.join("/tmp/user-data", "reporting"),
      path.join("/tmp/project-root", "open-webui-data", "reporting"),
    ],
  );
});

test("legacy cleanup removes all payload artifacts and preserves sibling streams", async (t) => {
  const reportingRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "portico-reporting-cleanup-"),
  );
  t.after(() => fs.rmSync(reportingRoot, { recursive: true, force: true }));

  fs.mkdirSync(path.join(reportingRoot, "payloads", "nested"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(reportingRoot, "payloads", "request.json"), "{");
  fs.writeFileSync(path.join(reportingRoot, "payloads", ".request.tmp"), "");
  fs.writeFileSync(
    path.join(reportingRoot, "payloads", "nested", "request.json"),
    "legacy",
  );
  for (const stream of ["events", "errors", "snapshots"]) {
    fs.mkdirSync(path.join(reportingRoot, stream), { recursive: true });
    fs.writeFileSync(path.join(reportingRoot, stream, "keep.json"), "safe");
  }

  assert.deepEqual(
    await removeLegacyRequestPayloadsFromRoots([reportingRoot, reportingRoot]),
    { attempted: 1, ensuredAbsent: 1, failures: 0 },
  );
  assert.equal(fs.existsSync(path.join(reportingRoot, "payloads")), false);
  for (const stream of ["events", "errors", "snapshots"]) {
    assert.equal(fs.existsSync(path.join(reportingRoot, stream, "keep.json")), true);
  }
  assert.deepEqual(await removeLegacyRequestPayloadsFromRoots([reportingRoot]), {
    attempted: 1,
    ensuredAbsent: 1,
    failures: 0,
  });
});

test(
  "legacy cleanup unlinks a payload symlink without following it",
  { skip: process.platform === "win32" },
  async (t) => {
    const reportingRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "portico-reporting-symlink-"),
    );
    const outsideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "portico-reporting-outside-"),
    );
    t.after(() => fs.rmSync(reportingRoot, { recursive: true, force: true }));
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outsideRoot, "keep.json"), "safe");
    fs.symlinkSync(outsideRoot, path.join(reportingRoot, "payloads"), "dir");

    assert.deepEqual(
      await removeLegacyRequestPayloadsFromRoots([reportingRoot]),
      { attempted: 1, ensuredAbsent: 1, failures: 0 },
    );
    assert.equal(fs.existsSync(path.join(reportingRoot, "payloads")), false);
    assert.equal(fs.existsSync(path.join(outsideRoot, "keep.json")), true);
  },
);

test("legacy cleanup failure is contained and does not reveal roots", async () => {
  const result = await removeLegacyRequestPayloadsFromRoots(
    ["/private/example-reporting"],
    { fsPromises: { rm: async () => { throw new Error("denied"); } } },
  );
  assert.deepEqual(result, { attempted: 1, ensuredAbsent: 0, failures: 1 });
  assert.equal(JSON.stringify(result).includes("/private/example-reporting"), false);
});

test("gateway reporting binds require exact app-owned Compose labels", () => {
  const valid = gatewayInspection("/tmp/installed-reporting", {
    Mounts: [
      { Type: "bind", Source: "/tmp/installed-reporting", Destination: "/app/reporting" },
      { Type: "bind", Source: "/tmp/second-reporting", Destination: "/app/reporting" },
      { Type: "volume", Source: "reporting-volume", Destination: "/app/reporting" },
      { Type: "bind", Source: "/tmp/wrong", Destination: "/other" },
    ],
  });
  assert.deepEqual(extractAppOwnedGatewayReportingBinds(valid), [
    "/tmp/installed-reporting",
    "/tmp/second-reporting",
  ]);
  assert.deepEqual(
    extractAppOwnedGatewayReportingBinds({
      ...valid,
      Config: {
        Labels: {
          "com.docker.compose.project": "unrelated",
          "com.docker.compose.service": "llm-gateway",
        },
      },
    }),
    [],
  );
});

test("gateway discovery inspects every canonical and one-off app container", async () => {
  const invocations = [];
  const result = await collectAppOwnedGatewayReportingRoots({
    execFileAsync: async (...args) => {
      invocations.push(args);
      if (args[1][0] === "ps") {
        return { stdout: "canonical-id\none-off-id\ncanonical-id\n" };
      }
      return {
        stdout: JSON.stringify([
          gatewayInspection("/tmp/canonical-reporting"),
          gatewayInspection("/tmp/one-off-reporting"),
          gatewayInspection("/tmp/ignored", {
            Config: {
              Labels: {
                "com.docker.compose.project": "portico",
                "com.docker.compose.service": "unrelated",
              },
            },
          }),
          null,
        ]),
      };
    },
  });

  assert.deepEqual(result, {
    roots: ["/tmp/canonical-reporting", "/tmp/one-off-reporting"],
    failures: 0,
  });
  assert.deepEqual(invocations[0], [
    "docker",
    [
      "ps",
      "-a",
      "-q",
      "--filter",
      "label=com.docker.compose.project=portico",
      "--filter",
      "label=com.docker.compose.service=llm-gateway",
    ],
    { timeout: LEGACY_GATEWAY_INSPECT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  ]);
  assert.deepEqual(invocations[1], [
    "docker",
    ["inspect", "--type", "container", "canonical-id", "one-off-id"],
    { timeout: LEGACY_GATEWAY_INSPECT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  ]);
});

test("gateway discovery treats no containers as a clean no-op", async () => {
  let calls = 0;
  const result = await collectAppOwnedGatewayReportingRoots({
    execFileAsync: async () => {
      calls += 1;
      return { stdout: "\n" };
    },
  });
  assert.deepEqual(result, { roots: [], failures: 0 });
  assert.equal(calls, 1);
});

test("gateway discovery contains Docker, timeout, and malformed-output failures", async () => {
  assert.deepEqual(
    await collectAppOwnedGatewayReportingRoots({
      execFileAsync: async () => { throw new Error("docker unavailable"); },
    }),
    { roots: [], failures: 1 },
  );

  for (const inspectStdout of ["not-json", JSON.stringify({})]) {
    let calls = 0;
    assert.deepEqual(
      await collectAppOwnedGatewayReportingRoots({
        execFileAsync: async () => {
          calls += 1;
          return calls === 1 ? { stdout: "gateway-id" } : { stdout: inspectStdout };
        },
      }),
      { roots: [], failures: 1 },
    );
  }
});
