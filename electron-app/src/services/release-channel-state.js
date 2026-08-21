const fs = require("node:fs");
const path = require("node:path");

const {
  getDefaultReleaseChannel,
  resolveReleaseChannelName,
  resolveReleaseChannelPackage,
} = require("../utils/release-channel");

function getUpdateChannelPath(projectRoot) {
  if (typeof projectRoot !== "string" || !projectRoot.trim()) {
    throw new Error("Project root is not initialized");
  }
  return path.join(projectRoot, "UPDATE_CHANNEL");
}

function readReleaseChannelInfo(projectRoot, options = {}) {
  const fileSystem = options.fs || fs;
  const updateChannelPath = getUpdateChannelPath(projectRoot);
  if (!fileSystem.existsSync(updateChannelPath)) {
    return getDefaultReleaseChannel();
  }

  try {
    const rawValue = fileSystem.readFileSync(updateChannelPath, "utf8").trim();
    const channelInfo = resolveReleaseChannelPackage(rawValue, { allowLegacy: true });
    if (channelInfo) {
      return channelInfo;
    }
    options.onInvalid?.(rawValue);
  } catch (error) {
    options.onError?.(error);
  }
  return getDefaultReleaseChannel();
}

function writePackageNameAtomically(projectRoot, packageName, options = {}) {
  const fileSystem = options.fs || fs;
  const updateChannelPath = getUpdateChannelPath(projectRoot);
  const processId = options.processId ?? process.pid;
  const timestamp = options.timestamp ?? Date.now();
  const temporaryPath = `${updateChannelPath}.${processId}.${timestamp}.tmp`;

  try {
    fileSystem.writeFileSync(temporaryPath, `${packageName}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fileSystem.renameSync(temporaryPath, updateChannelPath);
  } finally {
    if (fileSystem.existsSync(temporaryPath)) {
      fileSystem.rmSync(temporaryPath, { force: true });
    }
  }
}

function writeReleaseChannelSelection(projectRoot, channelName, options = {}) {
  const fileSystem = options.fs || fs;
  const channelInfo = resolveReleaseChannelName(channelName);
  if (!channelInfo) {
    throw new Error("Invalid release channel name");
  }

  const updateChannelPath = getUpdateChannelPath(projectRoot);
  if (channelInfo.kind === "stable") {
    if (fileSystem.existsSync(updateChannelPath)) {
      fileSystem.unlinkSync(updateChannelPath);
    }
  } else {
    writePackageNameAtomically(projectRoot, channelInfo.packageName, options);
  }
  return channelInfo;
}

function seedReleaseChannelFromPackage(projectRoot, packageName, options = {}) {
  const fileSystem = options.fs || fs;
  const updateChannelPath = getUpdateChannelPath(projectRoot);
  if (fileSystem.existsSync(updateChannelPath)) {
    return false;
  }

  const channelInfo = resolveReleaseChannelPackage(packageName);
  if (!channelInfo || channelInfo.kind === "stable") {
    return false;
  }

  writePackageNameAtomically(projectRoot, channelInfo.packageName, options);
  return true;
}

module.exports = {
  getUpdateChannelPath,
  readReleaseChannelInfo,
  seedReleaseChannelFromPackage,
  writePackageNameAtomically,
  writeReleaseChannelSelection,
};
