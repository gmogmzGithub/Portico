const DEFAULT_CHANNEL_NAME = "stable";
const DEFAULT_PACKAGE_NAME = "portico";
const CUSTOM_PACKAGE_PREFIX = "portico_";
const MAX_CUSTOM_CHANNEL_LENGTH = 64;

const BUILTIN_CHANNELS = Object.freeze({
  stable: Object.freeze({
    name: "stable",
    packageName: DEFAULT_PACKAGE_NAME,
    kind: "stable",
    label: "Stable",
    custom: false,
    legacy: false,
  }),
  beta: Object.freeze({
    name: "beta",
    packageName: "portico_beta",
    kind: "beta",
    label: "Beta",
    custom: false,
    legacy: false,
  }),
  dev: Object.freeze({
    name: "dev",
    packageName: "portico_dev",
    kind: "dev",
    label: "Development",
    custom: false,
    legacy: false,
  }),
});

const BUILTIN_BY_PACKAGE = Object.freeze(
  Object.fromEntries(
    Object.values(BUILTIN_CHANNELS).map((channel) => [channel.packageName, channel]),
  ),
);

const CUSTOM_CHANNEL_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const LEGACY_PACKAGE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;

function cloneChannelInfo(info) {
  return info ? { ...info } : null;
}

function normalizeReleaseChannelName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validateCustomReleaseChannelName(value) {
  const name = normalizeReleaseChannelName(value);
  if (!name) {
    return {
      valid: false,
      name,
      error: "Enter a release channel name.",
    };
  }
  if (Object.prototype.hasOwnProperty.call(BUILTIN_CHANNELS, name)) {
    return {
      valid: false,
      name,
      error: `${BUILTIN_CHANNELS[name].label} already has its own release channel menu item.`,
    };
  }
  if (name.length > MAX_CUSTOM_CHANNEL_LENGTH) {
    return {
      valid: false,
      name,
      error: `Release channel names must be ${MAX_CUSTOM_CHANNEL_LENGTH} characters or fewer.`,
    };
  }
  if (!CUSTOM_CHANNEL_PATTERN.test(name)) {
    return {
      valid: false,
      name,
      error:
        "Use lowercase letters, numbers, hyphens, or underscores, and start and end with a letter or number.",
    };
  }
  return { valid: true, name, error: null };
}

function resolveReleaseChannelName(value) {
  const name = normalizeReleaseChannelName(value);
  if (Object.prototype.hasOwnProperty.call(BUILTIN_CHANNELS, name)) {
    return cloneChannelInfo(BUILTIN_CHANNELS[name]);
  }

  const validation = validateCustomReleaseChannelName(name);
  if (!validation.valid) {
    return null;
  }
  return {
    name: validation.name,
    packageName: `${CUSTOM_PACKAGE_PREFIX}${validation.name}`,
    kind: "custom",
    label: validation.name,
    custom: true,
    legacy: false,
  };
}

function resolveReleaseChannelPackage(value, options = {}) {
  const packageName = typeof value === "string" ? value.trim() : "";
  if (!packageName) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(BUILTIN_BY_PACKAGE, packageName)) {
    return cloneChannelInfo(BUILTIN_BY_PACKAGE[packageName]);
  }

  if (packageName.startsWith(CUSTOM_PACKAGE_PREFIX)) {
    const name = packageName.slice(CUSTOM_PACKAGE_PREFIX.length);
    const validation = validateCustomReleaseChannelName(name);
    if (!validation.valid) {
      return null;
    }
    return {
      name: validation.name,
      packageName,
      kind: "custom",
      label: validation.name,
      custom: true,
      legacy: false,
    };
  }

  if (
    options.allowLegacy === true &&
    packageName.length <= 128 &&
    LEGACY_PACKAGE_PATTERN.test(packageName)
  ) {
    return {
      name: packageName,
      packageName,
      kind: "custom",
      label: packageName,
      custom: true,
      legacy: true,
    };
  }

  return null;
}

function getDefaultReleaseChannel() {
  return cloneChannelInfo(BUILTIN_CHANNELS[DEFAULT_CHANNEL_NAME]);
}

function createReleaseChannelMenuItems(currentChannel, actions = {}) {
  const channelInfo = currentChannel || getDefaultReleaseChannel();
  return [
    {
      label: "Stable",
      type: "radio",
      checked: channelInfo.kind === "stable",
      click: actions.stable,
    },
    {
      label: "Beta",
      type: "radio",
      checked: channelInfo.kind === "beta",
      click: actions.beta,
    },
    {
      label: "Development",
      type: "radio",
      checked: channelInfo.kind === "dev",
      click: actions.dev,
    },
    {
      label: "Custom...",
      type: "radio",
      checked: channelInfo.kind === "custom",
      click: actions.custom,
    },
  ];
}

const releaseChannelHelpers = {
  BUILTIN_CHANNELS,
  CUSTOM_PACKAGE_PREFIX,
  DEFAULT_CHANNEL_NAME,
  DEFAULT_PACKAGE_NAME,
  MAX_CUSTOM_CHANNEL_LENGTH,
  createReleaseChannelMenuItems,
  getDefaultReleaseChannel,
  normalizeReleaseChannelName,
  resolveReleaseChannelName,
  resolveReleaseChannelPackage,
  validateCustomReleaseChannelName,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = releaseChannelHelpers;
}

if (typeof window !== "undefined") {
  window.releaseChannelHelpers = releaseChannelHelpers;
}
