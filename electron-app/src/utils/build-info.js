var buildInfoReleaseChannelHelpers =
  typeof module !== 'undefined' && module.exports
    ? require('./release-channel')
    : window.releaseChannelHelpers;

var CHANNEL_MAP = {
  'portico': 'stable',
  'portico_beta': 'beta',
  'portico_dev': 'dev'
};
var CHANNEL_LABELS = {
  stable: 'Stable',
  beta: 'Beta',
  dev: 'Dev',
  custom: 'Custom'
};
var BUILD_INFO_CUSTOM_CHANNEL_PREFIX =
  buildInfoReleaseChannelHelpers?.CUSTOM_PACKAGE_PREFIX || 'portico_';
var BUILD_INFO_MAX_CUSTOM_CHANNEL_LENGTH =
  buildInfoReleaseChannelHelpers?.MAX_CUSTOM_CHANNEL_LENGTH || 64;
var BUILD_INFO_CUSTOM_CHANNEL_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
var BUILD_INFO_LEGACY_PACKAGE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;

function fallbackResolveReleaseChannelName(value) {
  const name = normalizeReleaseChannelName(value);
  if (name === 'stable') {
    return {
      name: 'stable',
      packageName: 'portico',
      kind: 'stable',
      label: 'Stable',
      custom: false,
      legacy: false,
    };
  }
  if (name === 'beta') {
    return {
      name: 'beta',
      packageName: 'portico_beta',
      kind: 'beta',
      label: 'Beta',
      custom: false,
      legacy: false,
    };
  }
  if (name === 'dev') {
    return {
      name: 'dev',
      packageName: 'portico_dev',
      kind: 'dev',
      label: 'Development',
      custom: false,
      legacy: false,
    };
  }
  if (!isValidFallbackCustomChannelName(name)) {
    return null;
  }
  return {
    name,
    packageName: `${BUILD_INFO_CUSTOM_CHANNEL_PREFIX}${name}`,
    kind: 'custom',
    label: name,
    custom: true,
    legacy: false,
  };
}

function fallbackResolveReleaseChannelPackage(value, options = {}) {
  const packageName = typeof value === 'string' ? value.trim() : '';
  if (!packageName) return null;

  const mappedKind = CHANNEL_MAP[packageName];
  if (mappedKind) {
    return {
      name: mappedKind,
      packageName,
      kind: mappedKind,
      label: mappedKind === 'dev' ? 'Development' : CHANNEL_LABELS[mappedKind],
      custom: false,
      legacy: false,
    };
  }

  if (packageName.startsWith(BUILD_INFO_CUSTOM_CHANNEL_PREFIX)) {
    const name = packageName.slice(BUILD_INFO_CUSTOM_CHANNEL_PREFIX.length);
    if (!isValidFallbackCustomChannelName(name)) return null;
    return {
      name,
      packageName,
      kind: 'custom',
      label: name,
      custom: true,
      legacy: false,
    };
  }

  if (
    options.allowLegacy === true &&
    packageName.length <= 128 &&
    BUILD_INFO_LEGACY_PACKAGE_PATTERN.test(packageName)
  ) {
    return {
      name: packageName,
      packageName,
      kind: 'custom',
      label: packageName,
      custom: true,
      legacy: true,
    };
  }

  return null;
}

function isValidFallbackCustomChannelName(value) {
  const channelName = normalizeReleaseChannelName(value);
  if (!channelName || channelName.length > BUILD_INFO_MAX_CUSTOM_CHANNEL_LENGTH) return false;
  if (channelName === 'stable' || channelName === 'beta' || channelName === 'dev') {
    return false;
  }
  return BUILD_INFO_CUSTOM_CHANNEL_PATTERN.test(channelName);
}

function resolveChannelPackage(value) {
  return (
    buildInfoReleaseChannelHelpers?.resolveReleaseChannelPackage?.(value, {
      allowLegacy: true,
    }) ||
    fallbackResolveReleaseChannelPackage(value, { allowLegacy: true })
  );
}

function normalizeReleaseChannelName(value) {
  if (buildInfoReleaseChannelHelpers?.normalizeReleaseChannelName) {
    return buildInfoReleaseChannelHelpers.normalizeReleaseChannelName(value);
  }
  return String(value || '').trim().toLowerCase();
}

function validateCustomReleaseChannelName(value) {
  const validation = buildInfoReleaseChannelHelpers?.validateCustomReleaseChannelName?.(value);
  return validation?.valid === true || isValidFallbackCustomChannelName(value);
}

function releaseChannelToPackageName(value) {
  return (
    buildInfoReleaseChannelHelpers?.resolveReleaseChannelName?.(value)?.packageName ||
    fallbackResolveReleaseChannelName(value)?.packageName ||
    null
  );
}

function releasePackageNameToChannel(value) {
  return (
    buildInfoReleaseChannelHelpers?.resolveReleaseChannelPackage?.(value)?.name ||
    fallbackResolveReleaseChannelPackage(value)?.name ||
    null
  );
}

function validateReleaseChannelPackageName(value) {
  return Boolean(resolveChannelPackage(value));
}

function getReleaseChannelDisplay(value) {
  return resolveChannelPackage(value)?.kind || 'stable';
}

function getReleaseChannelLabel(value) {
  const channelInfo = resolveChannelPackage(value);
  if (channelInfo?.kind === 'dev') {
    return 'Dev';
  }
  return channelInfo?.label || CHANNEL_LABELS[channelInfo?.kind] || 'Stable';
}

function resolveReleaseChannelPackageInput(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) return null;
  return (
    releaseChannelToPackageName(rawValue) ||
    resolveChannelPackage(rawValue)?.packageName ||
    null
  );
}

function resolveBuildChannel(buildInfo = {}) {
  if (buildInfo.buildNumber === 'dev-build') {
    return 'portico_dev';
  }

  if (
    typeof buildInfo.channel === 'string' &&
    resolveChannelPackage(buildInfo.channel)
  ) {
    return resolveChannelPackage(buildInfo.channel).packageName;
  }

  if (
    typeof buildInfo.releaseChannelKeyword === 'string' &&
    resolveChannelPackage(buildInfo.releaseChannelKeyword)
  ) {
    return resolveChannelPackage(buildInfo.releaseChannelKeyword).packageName;
  }

  return 'portico';
}

function resolveBuildDisplayChannel(buildInfo = {}) {
  return resolveChannelPackage(resolveBuildChannel(buildInfo))?.kind || 'stable';
}

function getBuildChannelLabel(buildInfo = {}) {
  const channelInfo = resolveChannelPackage(resolveBuildChannel(buildInfo));
  if (channelInfo?.kind === 'dev') {
    return 'Dev';
  }
  return channelInfo?.label || 'Stable';
}

function getResolvedBuildChannelInfo(buildInfo = {}) {
  const channelKeyword = resolveBuildChannel(buildInfo);
  const channelInfo = resolveChannelPackage(channelKeyword);
  const displayChannel = channelInfo?.kind || 'stable';
  const label = channelInfo?.kind === 'dev' ? 'Dev' : channelInfo?.label || 'Stable';

  return {
    channelKeyword,
    displayChannel,
    label,
  };
}

// Build info utility - extracted from renderer.js
function renderBuildInfo(buildInfo, targetElement, copyButton) {
  if (!buildInfo || !buildInfo.buildNumber || !targetElement) return;

  const displayChannel = resolveBuildDisplayChannel(buildInfo);
  const channelLabel = getBuildChannelLabel(buildInfo);
  const channelBadge = `<span class="channel-badge ${displayChannel}">${channelLabel}</span>`;

  targetElement.innerHTML = `${channelBadge} Build: ${buildInfo.buildNumber}`;

  // Setup copy functionality - copy full build string with channel
  if (copyButton && window.electronAPI) {
    copyButton.onclick = async () => {
      try {
        const fullBuildString = `Portico ${channelLabel} Build: ${buildInfo.buildNumber}`;
        await window.electronAPI.copyToClipboard(fullBuildString);
        const originalHTML = copyButton.innerHTML;

        // Show copied feedback
        copyButton.classList.add('copied');
        copyButton.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Copied!</span>
        `;

        // Reset after 2 seconds
        setTimeout(() => {
          copyButton.classList.remove('copied');
          copyButton.innerHTML = originalHTML;
        }, 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    };
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CHANNEL_MAP,
    CHANNEL_LABELS,
    CUSTOM_CHANNEL_PREFIX: BUILD_INFO_CUSTOM_CHANNEL_PREFIX,
    MAX_CUSTOM_CHANNEL_LENGTH: BUILD_INFO_MAX_CUSTOM_CHANNEL_LENGTH,
    normalizeReleaseChannelName,
    validateCustomReleaseChannelName,
    releaseChannelToPackageName,
    releasePackageNameToChannel,
    validateReleaseChannelPackageName,
    getReleaseChannelDisplay,
    getReleaseChannelLabel,
    resolveReleaseChannelPackageInput,
    resolveBuildChannel,
    resolveBuildDisplayChannel,
    getBuildChannelLabel,
    getResolvedBuildChannelInfo,
    renderBuildInfo,
  };
}

if (typeof window !== 'undefined') {
  window.buildInfoHelpers = {
    CHANNEL_MAP,
    CHANNEL_LABELS,
    CUSTOM_CHANNEL_PREFIX: BUILD_INFO_CUSTOM_CHANNEL_PREFIX,
    MAX_CUSTOM_CHANNEL_LENGTH: BUILD_INFO_MAX_CUSTOM_CHANNEL_LENGTH,
    normalizeReleaseChannelName,
    validateCustomReleaseChannelName,
    releaseChannelToPackageName,
    releasePackageNameToChannel,
    validateReleaseChannelPackageName,
    getReleaseChannelDisplay,
    getReleaseChannelLabel,
    resolveReleaseChannelPackageInput,
    resolveBuildChannel,
    resolveBuildDisplayChannel,
    getBuildChannelLabel,
    getResolvedBuildChannelInfo,
    renderBuildInfo,
  };
}
