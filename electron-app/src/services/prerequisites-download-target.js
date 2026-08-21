const { getResolvedBuildChannelInfo } = require("../utils/build-info");

const DEFAULT_PREREQUISITES_CHANNEL = "portico";
const DEFAULT_LOCAL_DEV_CHANNEL = "portico_dev";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function resolvePrerequisitesDownloadTarget({ buildNumber = null, buildInfo = null } = {}) {
  const normalizedBuildInfo =
    buildInfo && typeof buildInfo === "object" && !Array.isArray(buildInfo)
      ? buildInfo
      : {};
  const effectiveBuildNumber = isNonEmptyString(buildNumber)
    ? buildNumber.trim()
    : isNonEmptyString(normalizedBuildInfo.buildNumber)
      ? normalizedBuildInfo.buildNumber.trim()
      : null;

  if (!effectiveBuildNumber) {
    return {
      success: false,
      error: "No build number and build-info.json not found",
    };
  }

  const resolvedChannelInfo = getResolvedBuildChannelInfo({
    ...normalizedBuildInfo,
    buildNumber: effectiveBuildNumber,
  });

  if (effectiveBuildNumber === "dev-build") {
    const localDevChannel =
      resolvedChannelInfo.channelKeyword &&
      resolvedChannelInfo.channelKeyword !== DEFAULT_PREREQUISITES_CHANNEL
        ? resolvedChannelInfo.channelKeyword
        : DEFAULT_LOCAL_DEV_CHANNEL;

    return {
      success: true,
      buildNumber: effectiveBuildNumber,
      channel: localDevChannel,
      floatingLatest: false,
      localOnly: true,
    };
  }

  return {
    success: true,
    buildNumber: effectiveBuildNumber,
    channel: resolvedChannelInfo.channelKeyword || DEFAULT_PREREQUISITES_CHANNEL,
    floatingLatest: false,
    localOnly: false,
  };
}

module.exports = {
  DEFAULT_LOCAL_DEV_CHANNEL,
  DEFAULT_PREREQUISITES_CHANNEL,
  resolvePrerequisitesDownloadTarget,
};
