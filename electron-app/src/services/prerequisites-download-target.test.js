const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolvePrerequisitesDownloadTarget,
} = require("./prerequisites-download-target");

test("packaged stable build keeps its packaged stable channel", () => {
  const result = resolvePrerequisitesDownloadTarget({
    buildInfo: {
      buildNumber: "03112026-11111111",
      channel: "portico",
    },
  });

  assert.deepEqual(result, {
    success: true,
    buildNumber: "03112026-11111111",
    channel: "portico",
    floatingLatest: false,
    localOnly: false,
  });
});

test("packaged dev build uses the packaged dev channel", () => {
  const result = resolvePrerequisitesDownloadTarget({
    buildInfo: {
      buildNumber: "03112026-22222222",
      channel: "portico_dev",
    },
  });

  assert.deepEqual(result, {
    success: true,
    buildNumber: "03112026-22222222",
    channel: "portico_dev",
    floatingLatest: false,
    localOnly: false,
  });
});

test("packaged custom build keeps its custom prerequisite channel", () => {
  const result = resolvePrerequisitesDownloadTarget({
    buildInfo: {
      buildNumber: "03112026-2a2a2a2a",
      channel: "portico_team-alpha",
    },
  });

  assert.deepEqual(result, {
    success: true,
    buildNumber: "03112026-2a2a2a2a",
    channel: "portico_team-alpha",
    floatingLatest: false,
    localOnly: false,
  });
});

test("local dev-build resolves to a local-only prereq target without Cloudsmith lookup", () => {
  const result = resolvePrerequisitesDownloadTarget({
    buildInfo: {
      buildNumber: "dev-build",
    },
  });

  assert.deepEqual(result, {
    success: true,
    buildNumber: "dev-build",
    channel: "portico_dev",
    floatingLatest: false,
    localOnly: true,
  });
});

test("missing packaged channel falls back to stable for non-dev builds", () => {
  const result = resolvePrerequisitesDownloadTarget({
    buildInfo: {
      buildNumber: "03112026-33333333",
    },
  });

  assert.deepEqual(result, {
    success: true,
    buildNumber: "03112026-33333333",
    channel: "portico",
    floatingLatest: false,
    localOnly: false,
  });
});

test("explicit build number wins when provided", () => {
  const result = resolvePrerequisitesDownloadTarget({
    buildNumber: "03112026-44444444",
    buildInfo: {
      buildNumber: "03112026-55555555",
      channel: "portico_beta",
    },
  });

  assert.deepEqual(result, {
    success: true,
    buildNumber: "03112026-44444444",
    channel: "portico_beta",
    floatingLatest: false,
    localOnly: false,
  });
});

test("missing build info and explicit build number returns an error", () => {
  const result = resolvePrerequisitesDownloadTarget();
  assert.equal(result.success, false);
  assert.match(result.error, /No build number/);
});
