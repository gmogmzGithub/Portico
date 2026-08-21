const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildsMatch,
  describeBuildIdentity,
  getPreparedRuntimeRepairCandidate,
} = require("./runtime-repair");

function withTempDir(fn) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "runtime-repair-test-"),
  );
  try {
    return fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("prepared runtime repair candidate is accepted only when it matches the bundled build identity", () => {
  withTempDir((tempDir) => {
    const buildInfoPath = path.join(tempDir, "prepared-build-info.json");
    fs.writeFileSync(
      buildInfoPath,
      JSON.stringify(
        {
          buildNumber: "03172026-deadbeef",
          channel: "portico_beta",
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = getPreparedRuntimeRepairCandidate({
      bundledBuild: {
        buildNumber: "03172026-deadbeef",
        channel: "portico_beta",
      },
      preparedState: {
        prepared: {
          buildInfoPath,
          updateKey: "update-key",
          checksumAlgorithm: "sha256",
          checksumValue: "abc123",
        },
      },
      validatePreparedArtifactsForInstall(prepared) {
        return { success: true, prepared };
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.matches, true);
    assert.equal(result.prepared.buildInfoPath, buildInfoPath);
    assert.equal(result.preparedBuild.data.buildNumber, "03172026-deadbeef");
  });
});

test("prepared runtime repair candidate is rejected when channel or build number diverges from the bundled build", () => {
  withTempDir((tempDir) => {
    const buildInfoPath = path.join(tempDir, "prepared-build-info.json");
    fs.writeFileSync(
      buildInfoPath,
      JSON.stringify(
        {
          buildNumber: "03162026-cafebabe",
          channel: "portico",
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = getPreparedRuntimeRepairCandidate({
      bundledBuild: {
        buildNumber: "03172026-deadbeef",
        channel: "portico_beta",
      },
      preparedState: {
        prepared: {
          buildInfoPath,
          updateKey: "update-key",
          checksumAlgorithm: "sha256",
          checksumValue: "abc123",
        },
      },
      validatePreparedArtifactsForInstall(prepared) {
        return { success: true, prepared };
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.matches, false);
    assert.equal(result.reason, "prepared-build-mismatch");
  });
});

test("prepared runtime repair candidate rejects artifacts without checksum metadata", () => {
  withTempDir((tempDir) => {
    const buildInfoPath = path.join(tempDir, "prepared-build-info.json");
    fs.writeFileSync(
      buildInfoPath,
      JSON.stringify({
        buildNumber: "03172026-deadbeef",
        channel: "portico_beta",
      }),
      "utf8",
    );

    const prepared = { buildInfoPath, updateKey: "update-key" };
    const result = getPreparedRuntimeRepairCandidate({
      bundledBuild: {
        buildNumber: "03172026-deadbeef",
        channel: "portico_beta",
      },
      preparedState: { state: "interrupted", prepared },
      validatePreparedArtifactsForInstall() {
        return { success: true, prepared };
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, "prepared-checksum-missing");
  });
});

test("build identity matching includes channel and display text keeps both fields", () => {
  assert.equal(
    buildsMatch(
      { buildNumber: "03172026-deadbeef", channel: "portico" },
      { buildNumber: "03172026-deadbeef", channel: "portico_beta" },
    ),
    false,
  );
  assert.equal(
    describeBuildIdentity({
      buildNumber: "03172026-deadbeef",
      channel: "portico_beta",
    }),
    "03172026-deadbeef (portico_beta)",
  );
});

test("runtime repair treats custom channels as distinct build identities", () => {
  assert.equal(
    buildsMatch(
      {
        buildNumber: "03172026-deadbeef",
        channel: "portico_team-alpha",
      },
      {
        buildNumber: "03172026-deadbeef",
        channel: "portico_team-alpha",
      },
    ),
    true,
  );
  assert.equal(
    buildsMatch(
      {
        buildNumber: "03172026-deadbeef",
        channel: "portico_team-alpha",
      },
      {
        buildNumber: "03172026-deadbeef",
        channel: "portico_team-beta",
      },
    ),
    false,
  );
});
