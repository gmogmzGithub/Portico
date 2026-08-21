const fs = require("fs");

const { resolveBuildChannel } = require("../utils/build-info");

function normalizeBuildString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function readBuildInfoFile(filePath) {
  try {
    if (!normalizeBuildString(filePath) || !fs.existsSync(filePath)) {
      return {
        success: false,
        path: filePath || null,
        error: "build-info.json not found",
      };
    }

    return {
      success: true,
      path: filePath,
      data: JSON.parse(fs.readFileSync(filePath, "utf8")),
    };
  } catch (error) {
    return {
      success: false,
      path: filePath || null,
      error: error.message,
    };
  }
}

function resolveBuildIdentity(buildInfo = {}) {
  const normalizedBuildInfo =
    buildInfo && typeof buildInfo === "object" && !Array.isArray(buildInfo)
      ? buildInfo
      : {};

  return {
    buildNumber: normalizeBuildString(normalizedBuildInfo.buildNumber),
    channel: resolveBuildChannel(normalizedBuildInfo),
  };
}

function buildsMatch(left, right) {
  const normalizedLeft = resolveBuildIdentity(left);
  const normalizedRight = resolveBuildIdentity(right);

  return Boolean(
    normalizedLeft.buildNumber &&
      normalizedRight.buildNumber &&
      normalizedLeft.buildNumber === normalizedRight.buildNumber &&
      normalizedLeft.channel === normalizedRight.channel,
  );
}

function describeBuildIdentity(buildInfo = {}) {
  const identity = resolveBuildIdentity(buildInfo);

  if (identity.buildNumber && identity.channel) {
    return `${identity.buildNumber} (${identity.channel})`;
  }

  if (identity.buildNumber) {
    return identity.buildNumber;
  }

  return "unknown build";
}

function getPreparedRuntimeRepairCandidate({
  bundledBuild = null,
  preparedState = null,
  validatePreparedArtifactsForInstall = null,
} = {}) {
  if (
    !preparedState ||
    typeof preparedState !== "object" ||
    Array.isArray(preparedState)
  ) {
    return {
      success: false,
      matches: false,
      reason: "no-prepared-state",
    };
  }

  const prepared = preparedState.prepared || preparedState;
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
    return {
      success: false,
      matches: false,
      reason: "no-prepared-artifacts",
    };
  }

  if (typeof validatePreparedArtifactsForInstall !== "function") {
    return {
      success: false,
      matches: false,
      reason: "prepared-validator-missing",
    };
  }

  const validation = validatePreparedArtifactsForInstall(prepared);
  if (!validation?.success || !validation?.prepared) {
    return {
      success: false,
      matches: false,
      reason: "prepared-validation-failed",
      error:
        validation?.error || "Prepared update metadata is incomplete or invalid.",
    };
  }

  const checksumAlgorithm = normalizeBuildString(
    validation.prepared.checksumAlgorithm,
  );
  const checksumValue = normalizeBuildString(validation.prepared.checksumValue);
  if (!checksumAlgorithm || !checksumValue) {
    return {
      success: false,
      matches: false,
      reason: "prepared-checksum-missing",
      error: "Prepared update checksum metadata is missing.",
    };
  }

  const preparedBuild = readBuildInfoFile(validation.prepared.buildInfoPath);
  if (!preparedBuild.success) {
    return {
      success: false,
      matches: false,
      reason: "prepared-build-info-missing",
      error: preparedBuild.error,
    };
  }

  const matches = buildsMatch(bundledBuild, preparedBuild.data);
  return {
    success: true,
    matches,
    reason: matches ? null : "prepared-build-mismatch",
    prepared: validation.prepared,
    preparedBuild,
  };
}

module.exports = {
  buildsMatch,
  describeBuildIdentity,
  getPreparedRuntimeRepairCandidate,
  readBuildInfoFile,
  resolveBuildIdentity,
};
