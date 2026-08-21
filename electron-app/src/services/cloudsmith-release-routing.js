const {
  getReleaseChannelDisplay,
  getReleaseChannelLabel,
  validateReleaseChannelPackageName,
} = require('../utils/build-info');

const ROUTING_TAG_VERSION = 'portico-routing-v1';
const ROUTING_TAG_EOL = 'portico-eol-true';
const ROUTING_TAG_FORCE_UPDATE = 'portico-force-update-true';
const ROUTING_TAG_REDIRECT_PREFIX = 'portico-redirect-';
const UPDATE_READY_TAG = 'portico-update-ready-v1';

function getPackageSlug(pkg) {
  if (!pkg || typeof pkg !== 'object') {
    return null;
  }

  const candidates = [
    pkg.slug_perm,
    pkg.slug,
    pkg.identifier,
    pkg.package_slug_perm,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function flattenTagValue(value, tags) {
  if (typeof value === 'string') {
    const tag = value.trim();
    if (tag) {
      tags.add(tag);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      flattenTagValue(item, tags);
    }
    return;
  }

  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      flattenTagValue(item, tags);
    }
  }
}

function collectPackageTags(pkg) {
  const tags = new Set();
  if (!pkg || typeof pkg !== 'object') {
    return [];
  }

  flattenTagValue(pkg.tags, tags);
  flattenTagValue(pkg.tags_immutable, tags);
  return Array.from(tags).sort();
}

function isUpdateReadyPackage(pkg) {
  const tags = new Set();
  if (pkg && typeof pkg === 'object') {
    flattenTagValue(pkg.tags_immutable, tags);
  }
  return tags.has(UPDATE_READY_TAG);
}

function parseRoutingTags(pkg) {
  const tags = collectPackageTags(pkg);
  const hasVersion = tags.includes(ROUTING_TAG_VERSION);
  const hasEol = tags.includes(ROUTING_TAG_EOL);
  const hasForceUpdate = tags.includes(ROUTING_TAG_FORCE_UPDATE);
  const redirectTags = tags.filter(tag => tag.startsWith(ROUTING_TAG_REDIRECT_PREFIX));
  const hasRoutingTags = hasVersion || hasEol || hasForceUpdate || redirectTags.length > 0;

  if (!hasRoutingTags) {
    return null;
  }
  if (!hasVersion) {
    throw new Error(`Cloudsmith EOL routing tags missing ${ROUTING_TAG_VERSION}`);
  }
  if (!hasEol) {
    throw new Error(`Cloudsmith EOL routing tags missing ${ROUTING_TAG_EOL}`);
  }
  if (!hasForceUpdate) {
    throw new Error(`Cloudsmith EOL routing tags missing ${ROUTING_TAG_FORCE_UPDATE}`);
  }
  if (redirectTags.length === 0) {
    throw new Error(`Cloudsmith EOL routing tags missing ${ROUTING_TAG_REDIRECT_PREFIX}*`);
  }
  if (redirectTags.length > 1) {
    throw new Error('Cloudsmith EOL routing tags contain multiple redirect targets');
  }

  const redirectChannel = redirectTags[0].slice(ROUTING_TAG_REDIRECT_PREFIX.length).trim();
  if (!validateReleaseChannelPackageName(redirectChannel)) {
    throw new Error(
      `Cloudsmith EOL routing redirect tag is invalid: ${redirectChannel || '<empty>'}`,
    );
  }

  return {
    eol: true,
    redirectChannel,
    forceUpdate: true,
    reason: '',
    updatedAt: null,
  };
}

async function resolveEolRedirectForPackage({
  sourceChannel,
  sourcePackage,
  fetchLatestPackageForChannel,
}) {
  if (typeof fetchLatestPackageForChannel !== 'function') {
    throw new Error('fetchLatestPackageForChannel callback is required');
  }

  const sourceRouting = parseRoutingTags(sourcePackage);
  if (!sourceRouting) {
    return {
      redirected: false,
      channel: sourceChannel,
      package: sourcePackage,
      routing: null,
    };
  }

  const targetChannel = sourceRouting.redirectChannel;
  if (targetChannel === sourceChannel) {
    throw new Error(`Cloudsmith EOL routing tags redirect ${sourceChannel} to itself`);
  }

  const targetPackage = await fetchLatestPackageForChannel(targetChannel);
  if (!targetPackage) {
    throw new Error(`No downloadable binaries found for EOL redirect channel "${targetChannel}"`);
  }

  const targetRouting = parseRoutingTags(targetPackage);
  if (targetRouting?.eol) {
    throw new Error(
      `Cloudsmith EOL redirect target "${targetChannel}" is also EOL; chained redirects are unsupported`,
    );
  }

  return {
    redirected: true,
    channel: targetChannel,
    package: targetPackage,
    routing: sourceRouting,
    eolRedirect: {
      fromChannel: sourceChannel,
      fromBuildNumber: sourcePackage.buildNumber || sourcePackage.version || null,
      toChannel: targetChannel,
      toBuildNumber: targetPackage.buildNumber || targetPackage.version || null,
      reason: '',
    },
  };
}

function getUpdateChannelDisplay(channelPackageName) {
  return getReleaseChannelDisplay(channelPackageName);
}

function getUpdateChannelLabel(channelPackageName) {
  return getReleaseChannelLabel(channelPackageName);
}

module.exports = {
  ROUTING_TAG_VERSION,
  ROUTING_TAG_EOL,
  ROUTING_TAG_FORCE_UPDATE,
  ROUTING_TAG_REDIRECT_PREFIX,
  UPDATE_READY_TAG,
  collectPackageTags,
  getPackageSlug,
  getUpdateChannelDisplay,
  getUpdateChannelLabel,
  isUpdateReadyPackage,
  parseRoutingTags,
  resolveEolRedirectForPackage,
};
