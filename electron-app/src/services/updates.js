// updates.js - Cloudsmith update checking and version comparison utilities
// Handles update channel resolution, version checking, and update execution

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { app, dialog } = require('electron');

// Import shared state
const state = require('./shared-state');

// Import bootstrap for paths and utilities
const bootstrap = require('./bootstrap');
const { getThemeIcon } = bootstrap;
const {
  getDefaultReleaseChannel,
  resolveReleaseChannelName,
  resolveReleaseChannelPackage,
} = require('../utils/release-channel');
const { createRuntimeShellEnv } = require('./runtime-shell-env');
const { tagAppQuit } = require('./quit-provenance');
const {
  removeLegacyGuidedSetupDir,
} = require('./legacy-guided-setup-cleanup');

// Cloudsmith configuration — single source of truth (see cloudsmith.env)
const {
  CLOUDSMITH_OWNER,
  CLOUDSMITH_REPO,
  CLOUDSMITH_API_BASE,
  CLOUDSMITH_DL_BASE,
  CLOUDSMITH_READ_TOKEN,
  CLOUDSMITH_API_KEY,
  CLOUDSMITH_ENTITLEMENT_TOKEN,
} = require('../config/cloudsmith-config');
const {
  getUpdateChannelDisplay,
  getUpdateChannelLabel,
  isUpdateReadyPackage,
  resolveEolRedirectForPackage,
  UPDATE_READY_TAG,
} = require('./cloudsmith-release-routing');
const {
  validateReleaseChannelPackageName,
} = require('../utils/build-info');
const {
  writeReleaseChannelSelection,
} = require('./release-channel-state');

/**
 * Get PROJECT_ROOT from bootstrap (lazy access)
 */
function getProjectRoot() {
  return bootstrap.PROJECT_ROOT;
}

function getCloudsmithRoutingConfig() {
  return {
    CLOUDSMITH_API_BASE,
    CLOUDSMITH_API_KEY: CLOUDSMITH_API_KEY || CLOUDSMITH_READ_TOKEN,
  };
}

// ============================================================================
// UPDATE CHANNEL UTILITIES
// ============================================================================

// ============================================================================
// TIMESTAMP TRACKING FOR SAME-BUILD RE-UPLOAD DETECTION
// ============================================================================

/**
 * Get the path to the LAST_INSTALLED_BUILD timestamp file
 * @returns {string} - Full path to timestamp file
 */
function getLastInstalledTimestampPath() {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'portico',
    'LAST_INSTALLED_BUILD'
  );
}

const LAST_INSTALLED_BUILD_STATE_SCHEMA_VERSION = 1;

function normalizeLastInstalledBuildState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const buildNumber = typeof value.buildNumber === 'string'
    ? value.buildNumber.trim()
    : '';
  const timestamp = typeof value.timestamp === 'string'
    ? value.timestamp.trim()
    : '';
  if (
    value.schemaVersion !== LAST_INSTALLED_BUILD_STATE_SCHEMA_VERSION ||
    !buildNumber ||
    !timestamp ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    return null;
  }

  return {
    schemaVersion: LAST_INSTALLED_BUILD_STATE_SCHEMA_VERSION,
    buildNumber,
    timestamp,
    legacy: false,
  };
}

/**
 * Read the last successfully installed build identity from disk. Legacy files
 * contain only an unbound timestamp; callers may inspect them for diagnostics,
 * but must never use them to order a specific installed build.
 * @returns {{schemaVersion: number, buildNumber: string|null, timestamp: string, legacy: boolean}|null}
 */
function readLastInstalledBuildState() {
  try {
    const filePath = getLastInstalledTimestampPath();
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (!content) {
        return null;
      }

      try {
        const normalized = normalizeLastInstalledBuildState(JSON.parse(content));
        if (normalized) {
          console.log(
            '[Updates] Read last installed build state:',
            normalized.buildNumber,
            normalized.timestamp,
          );
          return normalized;
        }
      } catch (_error) {
        // Legacy state was a bare ISO timestamp rather than JSON.
      }

      if (Number.isFinite(Date.parse(content))) {
        console.warn(
          '[Updates] Ignoring legacy unbound LAST_INSTALLED_BUILD timestamp for version ordering:',
          content,
        );
        return {
          schemaVersion: 0,
          buildNumber: null,
          timestamp: content,
          legacy: true,
        };
      }
      console.warn('[Updates] Invalid LAST_INSTALLED_BUILD state:', content);
    }
    return null;
  } catch (error) {
    console.error('[Updates] Error reading last installed build state:', error.message);
    return null;
  }
}

/**
 * Compatibility accessor for callers that only need the recorded timestamp.
 */
function readLastInstalledTimestamp() {
  return readLastInstalledBuildState()?.timestamp || null;
}

/**
 * Save a successfully installed build identity and Cloudsmith timestamp.
 * @param {string} buildNumber - Installed build ID
 * @param {string} timestamp - ISO 8601 timestamp from Cloudsmith (uploaded_at/created_at)
 * @returns {boolean} - true if saved successfully
 */
function saveLastInstalledBuildState(buildNumber, timestamp) {
  try {
    const normalized = normalizeLastInstalledBuildState({
      schemaVersion: LAST_INSTALLED_BUILD_STATE_SCHEMA_VERSION,
      buildNumber,
      timestamp,
    });
    if (!normalized) {
      console.error('[Updates] Refusing to save invalid installed build state');
      return false;
    }

    const filePath = getLastInstalledTimestampPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify({
        schemaVersion: normalized.schemaVersion,
        buildNumber: normalized.buildNumber,
        timestamp: normalized.timestamp,
      }, null, 2)}\n`, 'utf8');
      fs.renameSync(tempPath, filePath);
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch (_error) {
        // Atomic rename normally consumes the temporary file.
      }
    }
    console.log(
      '[Updates] Saved last installed build state:',
      normalized.buildNumber,
      normalized.timestamp,
    );
    return true;
  } catch (error) {
    console.error('[Updates] Error saving last installed build state:', error.message);
    return false;
  }
}

function saveLastInstalledTimestamp(timestamp, buildNumber = state.buildInfo?.buildNumber) {
  return saveLastInstalledBuildState(buildNumber, timestamp);
}

const UPDATE_GRACE_DURATION_MS = 5 * 60 * 1000;

function getUpdateGraceStatePath() {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'portico',
    'update-grace-state.json'
  );
}

function getDefaultUpdateGraceState() {
  return {
    consumedKey: null,
    consumedAtMs: null,
    deferUntilMs: null
  };
}

function normalizeUpdateGraceState(rawState) {
  const defaults = getDefaultUpdateGraceState();
  if (!rawState || typeof rawState !== 'object') {
    return defaults;
  }

  const consumedKey = typeof rawState.consumedKey === 'string' && rawState.consumedKey
    ? rawState.consumedKey
    : null;
  const consumedAtMs = Number.isFinite(rawState.consumedAtMs) ? rawState.consumedAtMs : null;
  const deferUntilMs = Number.isFinite(rawState.deferUntilMs) ? rawState.deferUntilMs : null;

  return {
    consumedKey,
    consumedAtMs,
    deferUntilMs
  };
}

function readUpdateGraceState() {
  try {
    const filePath = getUpdateGraceStatePath();
    if (!fs.existsSync(filePath)) {
      return getDefaultUpdateGraceState();
    }

    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) {
      return getDefaultUpdateGraceState();
    }

    return normalizeUpdateGraceState(JSON.parse(content));
  } catch (error) {
    console.error('[Updates] Failed to read update grace state:', error.message);
    return getDefaultUpdateGraceState();
  }
}

function writeUpdateGraceState(newState) {
  try {
    const filePath = getUpdateGraceStatePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const normalizedState = normalizeUpdateGraceState(newState);
    fs.writeFileSync(filePath, JSON.stringify(normalizedState, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('[Updates] Failed to write update grace state:', error.message);
    return false;
  }
}

function normalizeChecksumValue(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function getChecksumIdentity(checksum) {
  if (!checksum || typeof checksum !== 'object') {
    return null;
  }

  const priority = ['sha256', 'sha512', 'sha1', 'md5'];
  for (const algorithm of priority) {
    const value = normalizeChecksumValue(checksum[algorithm]);
    if (value) {
      return { algorithm, value };
    }
  }

  return null;
}

function buildCloudsmithChecksum(pkg) {
  if (!pkg || typeof pkg !== 'object') {
    return null;
  }

  const checksum = {};
  const checksumFields = {
    sha256: pkg.checksum_sha256,
    sha512: pkg.checksum_sha512,
    sha1: pkg.checksum_sha1,
    md5: pkg.checksum_md5,
  };

  for (const [algorithm, rawValue] of Object.entries(checksumFields)) {
    const value = normalizeChecksumValue(rawValue);
    if (value) {
      checksum[algorithm] = value;
    }
  }

  return Object.keys(checksum).length > 0 ? checksum : null;
}

function buildUpdateGraceKey(updateInfo, currentChannel) {
  if (!updateInfo || !updateInfo.latestBuildNumber) {
    return null;
  }

  const buildNumber = updateInfo.latestBuildNumber;
  const channelKey = updateInfo.updateChannel || currentChannel || 'unknown';
  const checksumIdentity = getChecksumIdentity(updateInfo.checksum);

  if (!checksumIdentity) {
    return null;
  }

  return `${buildNumber}|${checksumIdentity.algorithm}:${checksumIdentity.value}|${channelKey}`;
}

function canOfferOneTimeUpdateGrace(updateInfo, currentChannel) {
  const key = buildUpdateGraceKey(updateInfo, currentChannel);
  if (!key) return false;

  const graceState = readUpdateGraceState();
  return graceState.consumedKey !== key;
}

function consumeOneTimeUpdateGrace(updateInfo, currentChannel) {
  const key = buildUpdateGraceKey(updateInfo, currentChannel);
  if (!key) {
    return {
      consumed: false,
      reason: 'missing-update-key',
      deferUntilMs: null
    };
  }

  const graceState = readUpdateGraceState();
  if (graceState.consumedKey === key) {
    return {
      consumed: false,
      reason: 'already-consumed',
      deferUntilMs: graceState.deferUntilMs,
      key
    };
  }

  const nowMs = Date.now();
  const deferUntilMs = nowMs + UPDATE_GRACE_DURATION_MS;
  const nextState = {
    consumedKey: key,
    consumedAtMs: nowMs,
    deferUntilMs
  };

  const persisted = writeUpdateGraceState(nextState);
  return {
    consumed: persisted,
    reason: persisted ? null : 'persist-failed',
    deferUntilMs,
    key
  };
}

function clearUpdateGraceState() {
  return writeUpdateGraceState(getDefaultUpdateGraceState());
}

function buildMissingChecksumErrorMessage(buildNumber) {
  const suffix = buildNumber ? ` for build ${buildNumber}` : '';
  return `Update payload checksum metadata is missing${suffix}. Refusing update flow.`;
}

// ============================================================================
// UPDATE CHANNEL UTILITIES
// ============================================================================

/**
 * Get the update channel from UPDATE_CHANNEL file or default to 'portico'
 * Supports built-in, canonical custom, and safe legacy custom package names.
 */
function getUpdateChannel() {
  try {
    const PROJECT_ROOT = getProjectRoot();
    const updateChannelFile = path.join(PROJECT_ROOT, 'UPDATE_CHANNEL');
    if (fs.existsSync(updateChannelFile)) {
      const content = fs.readFileSync(updateChannelFile, 'utf8').trim();
      if (content && content.length > 0) {
        const channelInfo = resolveReleaseChannelPackage(content, { allowLegacy: true });
        if (channelInfo) {
          console.log('Using update channel:', channelInfo.packageName);
          return channelInfo.packageName;
        }
        console.error(
          `[Updates] Ignoring malformed UPDATE_CHANNEL value and using Stable: ${JSON.stringify(content)}`,
        );
      }
    }
    // Default to standard channel
    console.log('Using default update channel: portico');
    return 'portico';
  } catch (error) {
    console.error('Error reading UPDATE_CHANNEL:', error);
    return 'portico'; // Default on error
  }
}

function getUpdateChannelInfo(packageName = getUpdateChannel()) {
  return resolveReleaseChannelPackage(packageName, { allowLegacy: true }) ||
    getDefaultReleaseChannel();
}

function persistUpdateChannel(updateChannel) {
  if (!validateReleaseChannelPackageName(updateChannel)) {
    throw new Error(`Invalid update channel package name: ${updateChannel || '<empty>'}`);
  }

  const PROJECT_ROOT = getProjectRoot();
  const channelInfo = resolveReleaseChannelPackage(updateChannel);
  writeReleaseChannelSelection(PROJECT_ROOT, channelInfo.name);
  console.log(`[Updates] Persisted redirected update channel: ${channelInfo.packageName}`);
}

// ============================================================================
// VERSION COMPARISON
// ============================================================================

/**
 * Compare build versions to determine if an update is available
 * @param {string} currentVersion - Current build number (e.g., "08252025-d3c55b37")
 * @param {string} latestVersion - Latest build number from Cloudsmith
 * @param {Object} [timestamps] - Trusted timestamps used to order different same-day SHAs
 * @param {string|null} [timestamps.currentTimestamp] - Installed build/package timestamp
 * @param {string|null} [timestamps.latestTimestamp] - Candidate Cloudsmith upload timestamp
 * @returns {boolean} - True if latest version is newer
 */
function isNewerVersion(currentVersion, latestVersion, timestamps = {}) {
  // The bridge build is an installed-state migration marker, not an update
  // target. Legacy clients that needed it still run their original updater;
  // current clients must never install or rank it as a release.
  if (isBridgeBuild(latestVersion)) return false;

  if (currentVersion === 'unknown' || currentVersion === 'dev-build') return true;

  // Extract date and SHA from version strings like "08252025-d3c55b37"
  const currentMatch = currentVersion.match(/(\d{8})-([a-f0-9]{8})/);
  const latestMatch = latestVersion.match(/(\d{8})-([a-f0-9]{8})/);

  if (!currentMatch || !latestMatch) return true; // If format is unexpected, assume update needed

  const [, currentDate, currentSha] = currentMatch;
  const [, latestDate, latestSha] = latestMatch;

  // Bridge build special case: 99999999 is a fake "max date" used to rescue
  // users stuck on builds with broken version comparison (pre-Jan 2026).
  // Only update to builds released AFTER the bridge build (01132026+).
  // This prevents "downgrading" to older broken builds still in the repository.
  if (currentDate === '99999999') {
    // Cutoff: only builds from this date onward are valid updates
    const BRIDGE_BUILD_CUTOFF = '01132026';  // Date bridge build was released
    const latestSortable = toSortableBuildDate(latestDate);
    const cutoffSortable = toSortableBuildDate(BRIDGE_BUILD_CUTOFF);

    return latestSortable >= cutoffSortable;
  }

  // Convert MMDDYYYY to YYYYMMDD for proper chronological comparison
  // (The old code used string comparison which failed across year boundaries)
  const currentSortable = toSortableBuildDate(currentDate);
  const latestSortable = toSortableBuildDate(latestDate);

  // Compare dates first
  if (latestSortable > currentSortable) return true;
  if (latestSortable < currentSortable) return false;

  if (latestSha === currentSha) return false;

  // Git SHA fragments have no ordering semantics. For different commits built
  // on the same day, update only when both sides have trustworthy timestamps.
  const currentTimestampMs = parseTimestampMs(timestamps.currentTimestamp);
  const latestTimestampMs = parseTimestampMs(timestamps.latestTimestamp);
  if (currentTimestampMs === null || latestTimestampMs === null) {
    return false;
  }
  return latestTimestampMs > currentTimestampMs;
}

function toSortableBuildDate(mmddyyyy) {
  const mm = mmddyyyy.substring(0, 2);
  const dd = mmddyyyy.substring(2, 4);
  const yyyy = mmddyyyy.substring(4, 8);
  return parseInt(yyyy + mm + dd, 10);
}

function parseTimestampMs(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function newestValidTimestamp(...values) {
  let newestValue = null;
  let newestTimestamp = null;
  for (const value of values) {
    const timestamp = parseTimestampMs(value);
    if (timestamp !== null && (newestTimestamp === null || timestamp > newestTimestamp)) {
      newestTimestamp = timestamp;
      newestValue = value;
    }
  }
  return newestValue;
}

function getPackageTimestamp(pkg) {
  if (!pkg || typeof pkg !== 'object') {
    return null;
  }

  return pkg.uploaded_at || pkg.created_at || null;
}

function comparePackagesByTimestampDesc(a, b) {
  const aTimestamp = getPackageTimestamp(a);
  const bTimestamp = getPackageTimestamp(b);

  if (aTimestamp && bTimestamp) {
    return new Date(bTimestamp) - new Date(aTimestamp);
  }
  if (aTimestamp) return -1;
  if (bTimestamp) return 1;
  return 0;
}

function comparePackagesByBuildRecencyDesc(a, b) {
  const aDate = toSortableBuildDate(a.buildDate);
  const bDate = toSortableBuildDate(b.buildDate);
  if (aDate !== bDate) {
    return bDate - aDate;
  }
  return comparePackagesByTimestampDesc(a, b);
}

function parsePackageBuildInfo(updateChannel, pkg) {
  const filename = pkg.filename || `${updateChannel}-${pkg.version}.zip`;
  const escapedChannel = updateChannel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escapedChannel}-(\\d{8})-([a-f0-9]{8,40})\\.zip$`);
  const match = filename.match(pattern);

  if (!match) {
    return null;
  }

  const [, buildDate, fullSha] = match;
  const shortSha = fullSha.length > 8 ? fullSha.substring(0, 8) : fullSha;

  return {
    ...pkg,
    filename,
    buildDate,
    fullSha,
    shortSha,
    buildNumber: `${buildDate}-${shortSha}`,
    timestamp: getPackageTimestamp(pkg),
  };
}

function isBridgeBuild(buildNumber) {
  return typeof buildNumber === 'string' && buildNumber.startsWith('99999999-');
}

function selectLatestPackageForCurrentBuild(
  parsedPackages,
  currentBuildNumber,
  currentTimestamp = null,
) {
  if (!parsedPackages || parsedPackages.length === 0) {
    return null;
  }

  const sortedPackages = [...parsedPackages].sort(comparePackagesByTimestampDesc);
  const sameBuildCandidates = sortedPackages.filter(pkg => pkg.buildNumber === currentBuildNumber);
  const exactInstalledPackageTimestamp = sameBuildCandidates.length > 0
    ? sameBuildCandidates[0].timestamp
    : null;
  const installedReferenceTimestamp = newestValidTimestamp(
    currentTimestamp,
    exactInstalledPackageTimestamp,
  );

  const upgradeCandidates = sortedPackages.filter(pkg =>
    pkg.buildNumber !== currentBuildNumber && isNewerVersion(
      currentBuildNumber,
      pkg.buildNumber,
      {
        currentTimestamp: installedReferenceTimestamp,
        latestTimestamp: pkg.timestamp,
      },
    )
  ).sort(comparePackagesByBuildRecencyDesc);
  if (upgradeCandidates.length > 0) {
    return upgradeCandidates[0];
  }

  if (sameBuildCandidates.length > 0) {
    return sameBuildCandidates[0];
  }

  if (isBridgeBuild(currentBuildNumber)) {
    // Preserve the bridge fallback for repositories that do not contain a
    // valid post-cutoff rescue target.
    return sortedPackages[0];
  }

  return [...parsedPackages].sort(comparePackagesByBuildRecencyDesc)[0];
}

// ============================================================================
// CLOUDSMITH HELPERS
// ============================================================================

/**
 * Build the common HTTP headers used for Cloudsmith package discovery requests.
 * Discovery uses the Cloudsmith read token path, which resolves to the API key.
 * Entitlement tokens are only valid for raw artifact downloads and must not be
 * sent as X-Api-Key to the packages API.
 */
function cloudsmithHeaders() {
  requireCloudsmithApiKeyForDiscovery();
  return {
    'Accept': 'application/json',
    'X-Api-Key': CLOUDSMITH_READ_TOKEN,
  };
}

function requireCloudsmithApiKeyForDiscovery() {
  if (CLOUDSMITH_READ_TOKEN) {
    return;
  }

  throw new Error(
    'Cloudsmith API key is not configured; cannot fetch update package data from the private update repository.',
  );
}

/**
 * Construct a download URL for a Cloudsmith raw package.
 * The entitlement token is embedded in the URL path so that end-users
 * (curl, the Electron app, etc.) can download without extra auth headers.
 *
 * If Cloudsmith returns a raw-package cdn_url, use it directly after replacing
 * '/basic/' with the entitlement token path segment. Otherwise, fall back to
 * the canonical raw package URL.
 *
 * Format: https://dl.artifacts.example.invalid/<token>/<repo>/raw/names/<channel>/versions/<version>/<filename>
 */
function buildCloudsmithDownloadUrl(packageName, version, filename, cdnUrl) {
  const normalizedPackageName = typeof packageName === 'string' ? packageName.trim() : '';
  const normalizedVersion = typeof version === 'string' ? version.trim() : '';
  const normalizedFilename = typeof filename === 'string' ? filename.trim() : '';
  const rawPackageUrlPattern = /\/raw\/names\/.+(?:\/versions\/.+\/.+|\/files\/.+)$/;

  if (typeof cdnUrl === 'string' && cdnUrl.trim()) {
    const normalizedCdnUrl = cdnUrl.trim();
    if (rawPackageUrlPattern.test(normalizedCdnUrl)) {
      if (CLOUDSMITH_ENTITLEMENT_TOKEN) {
        return normalizedCdnUrl.replace('/basic/', `/${CLOUDSMITH_ENTITLEMENT_TOKEN}/`);
      }
      return normalizedCdnUrl;
    }

    console.warn(
      `[Updates] Ignoring unexpected Cloudsmith cdn_url for ${normalizedFilename || 'unknown file'}; falling back to canonical raw URL`,
    );
  }

  if (!normalizedPackageName || !normalizedVersion || !normalizedFilename) {
    return null;
  }

  const tokenSegment = CLOUDSMITH_ENTITLEMENT_TOKEN
    ? `${CLOUDSMITH_ENTITLEMENT_TOKEN}/`
    : 'basic/';
  return `${CLOUDSMITH_DL_BASE}/${tokenSegment}${CLOUDSMITH_REPO}/raw/names/${normalizedPackageName}/versions/${normalizedVersion}/${normalizedFilename}`;
}

function attachDownloadUrl(updateChannel, pkg) {
  const downloadUrl = buildCloudsmithDownloadUrl(updateChannel, pkg.version, pkg.filename, pkg.cdn_url);
  if (!downloadUrl) {
    console.warn(
      `[Updates] Skipping ${pkg.filename || 'unknown file'} because no usable Cloudsmith download URL could be constructed`,
    );
    return null;
  }

  return {
    ...pkg,
    downloadUrl,
  };
}

function parseCloudsmithPackageList(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  if (Array.isArray(payload?.results)) {
    return payload.results;
  }
  return [];
}

async function fetchRawPackagesForChannel(updateChannel, options = {}) {
  const pageSize = options.pageSize || 100;
  const maxPages = options.maxPages || 3;
  // PORTICO-438: discovery requires the verified-payload marker (PORTICO-409). The
  // diagnostic probe below drops that clause so an operator can be told the
  // difference between "this channel has no package" and "the package is here
  // but was never verified".
  const requireReady = options.requireReady !== false;
  const allPackages = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const readyClause = requireReady ? ` tag:^${UPDATE_READY_TAG}$` : '';
    const packageQuery = encodeURIComponent(
      `name:^${updateChannel}$ format:raw${readyClause}`,
    );
    const apiUrl = `${CLOUDSMITH_API_BASE}/packages/${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}/` +
      `?query=${packageQuery}` +
      `&page_size=${pageSize}&page=${page}&sort=-date`;

    console.log(`Fetching ${updateChannel} packages (page ${page})...`);
    const response = await fetch(apiUrl, { headers: cloudsmithHeaders() });
    if (!response.ok) {
      if (page > 1 && response.status === 404) {
        console.log(`Page ${page}: Cloudsmith returned 404, treating it as the end of pagination`);
        break;
      }
      throw new Error(`Cloudsmith API request failed: ${response.status} ${response.statusText}`);
    }

    const pagePackages = parseCloudsmithPackageList(await response.json());
    allPackages.push(...pagePackages);

    console.log(`Page ${page}: fetched ${pagePackages.length} ${updateChannel} packages, total: ${allPackages.length}`);

    if (pagePackages.length > 0) {
      pagePackages.forEach(pkg => {
        console.log(`  - ${pkg.filename || pkg.name} v${pkg.version} (${getPackageTimestamp(pkg)})`);
      });
    }

    if (pagePackages.length < pageSize) break;
  }

  return allPackages;
}

function selectDownloadablePackageForChannel(
  updateChannel,
  packages,
  currentBuildNumber,
  currentReferenceTimestamp = null,
) {
  const chatBinaries = packages.filter(pkg =>
    (pkg.filename && pkg.filename.endsWith('.zip')) ||
    (pkg.name === updateChannel)
  );

  console.log(`Found ${chatBinaries.length} binary packages for ${updateChannel}`);

  if (chatBinaries.length === 0) {
    // PORTICO-344: this fires when the selected release channel has no builds (e.g.
    // Stable/Dev, which are empty). The old message ("No binaries found for
    // channel …") was cryptic and left the user stuck. Point them at the fix.
    //
    // PORTICO-438: `reason` lets the async callers distinguish an empty channel from
    // one holding an unverified package before they surface this text. That
    // distinction is not cosmetic: when the broker published `mr-330` without
    // the PORTICO-409 marker, this message said the channel was empty while the
    // build sat in Cloudsmith, and the misdirection cost hours of diagnosis.
    const channelInfo = resolveReleaseChannelPackage(updateChannel, { allowLegacy: true });
    const channelLabel = channelInfo ? channelInfo.label : updateChannel;
    return {
      success: false,
      reason: 'no-ready-packages',
      error:
        `No builds are available on the "${channelLabel}" release channel. ` +
        `Open the Portico menu → Switch Release Channel and choose a channel that has builds (e.g. Beta), then retry.`,
    };
  }

  const readyBinaries = chatBinaries.filter(isUpdateReadyPackage);
  const pendingPublicationCount = chatBinaries.length - readyBinaries.length;
  if (pendingPublicationCount > 0) {
    console.log(
      `[Updates] Ignoring ${pendingPublicationCount} package(s) that have not completed release verification`,
    );
  }
  if (readyBinaries.length === 0) {
    return {
      success: false,
      pendingPublication: true,
    };
  }

  const parsedBinaries = readyBinaries
    .map(pkg => parsePackageBuildInfo(updateChannel, pkg))
    .filter(Boolean);

  if (parsedBinaries.length === 0) {
    const invalidFilename = chatBinaries[0].filename || `${updateChannel}-${chatBinaries[0].version}.zip`;
    console.log(`Invalid binary name format: ${invalidFilename} (expected format: ${updateChannel}-MMDDYYYY-SHA.zip)`);
    return {
      success: false,
      error: `Invalid binary name format: ${invalidFilename} (expected: ${updateChannel}-MMDDYYYY-SHA.zip)`,
    };
  }

  const downloadableBinaries = parsedBinaries
    .map(pkg => attachDownloadUrl(updateChannel, pkg))
    .filter(Boolean);

  if (downloadableBinaries.length === 0) {
    return {
      success: false,
      error: `No downloadable binaries found for channel "${updateChannel}" in Cloudsmith repository`,
    };
  }

  const installableBinaries = downloadableBinaries.filter(
    pkg => !isBridgeBuild(pkg.buildNumber),
  );
  const ignoredBridgeBuildCount = downloadableBinaries.length - installableBinaries.length;
  if (ignoredBridgeBuildCount > 0) {
    console.warn(
      `[Updates] Ignoring ${ignoredBridgeBuildCount} legacy bridge package(s) as update targets`,
    );
  }
  if (installableBinaries.length === 0) {
    console.warn('[Updates] No installable release packages remain after excluding bridge builds');
    return {
      success: false,
      noInstallable: true,
    };
  }

  return {
    success: true,
    latest: selectLatestPackageForCurrentBuild(
      installableBinaries,
      currentBuildNumber,
      currentReferenceTimestamp,
    ),
  };
}

// PORTICO-438: when discovery finds nothing, say which of the two situations this is.
// A channel can be genuinely empty, or it can hold packages the publisher never
// marked verified. Those need different actions, and conflating them is what made
// a published `mr-330` build read as "no builds available" while it sat in
// Cloudsmith untagged. Runs only on the failure path, so successful discovery
// costs no extra request.
async function describeUnavailableChannel(updateChannel, fallbackMessage) {
  let unverified = [];
  try {
    unverified = await fetchRawPackagesForChannel(updateChannel, {
      requireReady: false,
      maxPages: 1,
    });
  } catch (error) {
    console.warn(
      `[Updates] Could not probe ${updateChannel} for unverified packages:`,
      error?.message || error,
    );
    return fallbackMessage;
  }

  if (unverified.length === 0) {
    return fallbackMessage;
  }

  const channelInfo = resolveReleaseChannelPackage(updateChannel, { allowLegacy: true });
  const channelLabel = channelInfo ? channelInfo.label : updateChannel;
  const newestVersion = unverified[0]?.version ? ` (newest ${unverified[0].version})` : '';
  return (
    `The "${channelLabel}" release channel has ${unverified.length} package(s)${newestVersion}, ` +
    `but none carry the ${UPDATE_READY_TAG} marker, so none can be installed. ` +
    `That marker is applied only after the publisher downloads the released payload ` +
    `back and verifies its checksum, so the release did not finish verifying. ` +
    `Ask for the release to be republished, or use Install Specific Build if you ` +
    `need this exact build.`
  );
}

async function fetchLatestDownloadablePackageForChannel(
  updateChannel,
  currentBuildNumber,
  currentReferenceTimestamp = null,
) {
  const packages = await fetchRawPackagesForChannel(updateChannel);
  const selection = selectDownloadablePackageForChannel(
    updateChannel,
    packages,
    currentBuildNumber,
    currentReferenceTimestamp,
  );
  if (!selection.success) {
    const fallback =
      selection.error ||
      `No installable release packages found for channel "${updateChannel}" in Cloudsmith repository`;
    throw new Error(
      selection.reason === 'no-ready-packages'
        ? await describeUnavailableChannel(updateChannel, fallback)
        : fallback,
    );
  }
  return selection.latest;
}

function buildUpdateInfoFromPackage({
  latest,
  updateChannel,
  currentBuildNumber,
  currentReferenceTimestamp = null,
  storedTimestamp = null,
  forceUpdate = false,
  eolRedirect = null,
}) {
  const filename = latest.filename;
  const latestTimestamp = latest.timestamp;
  const latestBuildNumber = latest.buildNumber;
  const latestFullSha = latest.fullSha;
  const downloadUrl = latest.downloadUrl;
  const updateChannelDisplay = getUpdateChannelDisplay(updateChannel);
  const updateChannelLabel = getUpdateChannelLabel(updateChannel);
  const latestChecksum = buildCloudsmithChecksum(latest);

  if (!latestChecksum) {
    return {
      updateAvailable: false,
      error: buildMissingChecksumErrorMessage(latestBuildNumber),
      currentBuildNumber,
      latestBuildNumber,
    };
  }

  console.log('Latest binary:', filename, 'uploaded:', latestTimestamp);
  console.log('Latest build number:', latestBuildNumber);
  console.log('Current build number:', currentBuildNumber);

  if (!forceUpdate && currentBuildNumber === latestBuildNumber) {
    const remoteTimestamp = latestTimestamp;

    let timestampUpdateAvailable = false;

    if (!storedTimestamp && remoteTimestamp) {
      console.log(
        '[Updates] Binding the running installed build to its exact Cloudsmith package timestamp',
      );
      saveLastInstalledBuildState(currentBuildNumber, remoteTimestamp);
    } else if (remoteTimestamp) {
      const storedDate = new Date(storedTimestamp);
      const remoteDate = new Date(remoteTimestamp);

      if (remoteDate > storedDate) {
        console.log('[Updates] Same build ID but Cloudsmith has newer timestamp');
        console.log(`  Stored:     ${storedTimestamp}`);
        console.log(`  Cloudsmith: ${remoteTimestamp}`);
        timestampUpdateAvailable = true;
      }
    }

    const sameBuildResult = {
      updateAvailable: timestampUpdateAvailable,
      currentBuildNumber,
      latestBuildNumber,
      latestFullSha,
      downloadUrl,
      filename,
      lastModified: latestTimestamp,
      fileSize: latest.size,
      checksum: latestChecksum,
      updateSource: 'cloudsmith',
      updateChannel,
      updateChannelDisplay,
      updateChannelLabel,
      inSync: !timestampUpdateAvailable,
      timestampUpdate: timestampUpdateAvailable
    };
    sameBuildResult.updateKey = buildUpdateGraceKey(sameBuildResult, updateChannel);
    return sameBuildResult;
  }

  const isNewer = forceUpdate || isNewerVersion(currentBuildNumber, latestBuildNumber, {
    currentTimestamp: currentReferenceTimestamp,
    latestTimestamp,
  });
  console.log(`Update check result: isNewer=${isNewer}, current=${currentBuildNumber}, latest=${latestBuildNumber}`);

  const updateResult = {
    updateAvailable: isNewer,
    currentBuildNumber,
    latestBuildNumber,
    latestFullSha,
    downloadUrl,
    filename,
    lastModified: latestTimestamp,
    fileSize: latest.size,
    checksum: latestChecksum,
    updateSource: 'cloudsmith',
    updateChannel,
    updateChannelDisplay,
    updateChannelLabel,
  };
  if (forceUpdate) {
    updateResult.forceUpdate = true;
  }
  if (eolRedirect) {
    updateResult.eolRedirect = eolRedirect;
  }
  updateResult.updateKey = buildUpdateGraceKey(updateResult, updateChannel);
  return updateResult;
}

// ============================================================================
// CLOUDSMITH UPDATE CHECKING
// ============================================================================

/**
 * Check for updates from Cloudsmith repository
 * Fetches available builds for the configured update channel and compares with current build
 * @returns {Promise<Object>} - Update info including availability, versions, and download URL
 */
async function checkForUpdates() {
  const buildInfo = state.buildInfo;

  // Skip update check entirely for dev-build (local development builds)
  if (buildInfo.buildNumber === 'dev-build') {
    console.log('[Update Check] Skipping Cloudsmith update check for dev-build');
    return {
      updateAvailable: false,
      currentBuildNumber: 'dev-build',
      skipped: true,
      skipReason: 'Running dev-build (local development build)'
    };
  }

  try {
    console.log('Checking for updates from Cloudsmith repository...');
    requireCloudsmithApiKeyForDiscovery();

    // Get the update channel (supports custom release channels)
    const updateChannel = getUpdateChannel();
    console.log(`Searching for packages with name: ${updateChannel}`);

    const allPackages = await fetchRawPackagesForChannel(updateChannel);
    console.log(`Total ${updateChannel} packages fetched: ${allPackages.length}`);

    const currentBuildNumber = buildInfo.buildNumber || 'unknown';
    const storedBuildState = readLastInstalledBuildState();
    const storedTimestamp = storedBuildState?.buildNumber === currentBuildNumber
      ? storedBuildState.timestamp
      : null;
    if (storedBuildState && !storedTimestamp) {
      console.warn(
        '[Updates] LAST_INSTALLED_BUILD does not identify the current build; excluding it from version ordering',
      );
    }
    const currentReferenceTimestamp = newestValidTimestamp(
      buildInfo.timestamp,
      storedTimestamp,
    );
    const selection = selectDownloadablePackageForChannel(
      updateChannel,
      allPackages,
      currentBuildNumber,
      currentReferenceTimestamp,
    );
    if (!selection.success) {
      if (selection.pendingPublication) {
        return {
          updateAvailable: false,
          currentBuildNumber,
          pendingPublication: true,
        };
      }
      return {
        updateAvailable: false,
        error:
          selection.reason === 'no-ready-packages'
            ? await describeUnavailableChannel(updateChannel, selection.error)
            : selection.error,
        currentBuildNumber
      };
    }

    const latest = selection.latest;
    const redirectResult = await resolveEolRedirectForPackage({
      cloudsmithConfig: getCloudsmithRoutingConfig(),
      sourceChannel: updateChannel,
      sourcePackage: latest,
      fetchLatestPackageForChannel: (targetChannel) =>
        fetchLatestDownloadablePackageForChannel(
          targetChannel,
          currentBuildNumber,
          currentReferenceTimestamp,
        ),
      logPrefix: '[Updates]',
      logger: console,
    });

    if (redirectResult.redirected) {
      console.log(
        `[Updates] Cloudsmith EOL redirect ${updateChannel} -> ${redirectResult.channel}`,
      );
      persistUpdateChannel(redirectResult.channel);
      return buildUpdateInfoFromPackage({
        latest: redirectResult.package,
        updateChannel: redirectResult.channel,
        currentBuildNumber,
        currentReferenceTimestamp,
        storedTimestamp,
        forceUpdate: true,
        eolRedirect: redirectResult.eolRedirect,
      });
    }

    return buildUpdateInfoFromPackage({
      latest,
      updateChannel,
      currentBuildNumber,
      currentReferenceTimestamp,
      storedTimestamp,
    });

  } catch (error) {
    console.error('Cloudsmith update check failed:', error.message || error);
    console.error('Error stack:', error.stack);
    return {
      updateAvailable: false,
      error: error.message || String(error),
      currentBuildNumber: state.buildInfo.buildNumber
    };
  }
}


/**
 * Find a specific build by ID in the current release channel
 * @param {string} buildId - Build ID in format MMDDYYYY-xxxxxxxx (e.g., "01132026-abc12345")
 * @returns {Promise<Object>} - Build info if found, or error object
 */
async function findSpecificBuild(buildId) {
  const buildInfo = state.buildInfo;

  // Validate build ID format
  const buildIdPattern = /^(\d{8})-([a-f0-9]{8})$/;
  if (!buildIdPattern.test(buildId)) {
    return {
      found: false,
      error: 'Invalid build ID format. Expected format: MMDDYYYY-xxxxxxxx (e.g., 01132026-abc12345)'
    };
  }

  if (isBridgeBuild(buildId)) {
    return {
      found: false,
      error: 'Legacy bridge builds cannot be installed as update targets'
    };
  }

  try {
    const updateChannel = getUpdateChannel();
    console.log(`Searching for build ${buildId} in channel ${updateChannel}...`);
    requireCloudsmithApiKeyForDiscovery();

    const [, targetDate, targetSha] = buildId.match(buildIdPattern);

    // Query Cloudsmith packages API for the specific version
    // The version in Cloudsmith should match the build ID (MMDDYYYY-SHA)
    const apiUrl = `${CLOUDSMITH_API_BASE}/packages/${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}/` +
      `?query=name:^${encodeURIComponent(updateChannel)}$ format:raw` +
      `&page_size=100&sort=-date`;

    const response = await fetch(apiUrl, { headers: cloudsmithHeaders() });
    if (!response.ok) {
      throw new Error(`Cloudsmith API request failed: ${response.status}`);
    }

    const packages = await response.json();

    // Search for the specific build by matching version or filename
    const escapedChannel = updateChannel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    for (const pkg of packages) {
      const filename = pkg.filename || `${updateChannel}-${pkg.version}.zip`;
      const pattern = new RegExp(`${escapedChannel}-(\\d{8})-([a-f0-9]{8,40})\\.zip$`);
      const match = filename.match(pattern);

      if (match) {
        const [, date, sha] = match;
        const shortSha = sha.substring(0, 8);

        // Check if this is the requested build
        if (date === targetDate && shortSha === targetSha) {
          console.log(`Found matching build: ${filename}`);

          const downloadUrl = buildCloudsmithDownloadUrl(updateChannel, pkg.version, filename, pkg.cdn_url);
          if (!downloadUrl) {
            console.warn(
              `[Updates] Skipping ${filename} because no usable Cloudsmith download URL could be constructed`,
            );
            continue;
          }

          const packageTimestamp = getPackageTimestamp(pkg);
          const checksum = buildCloudsmithChecksum(pkg);
          if (!checksum) {
            return {
              found: false,
              error: buildMissingChecksumErrorMessage(buildId),
              updateChannel: updateChannel,
            };
          }

          const foundBuild = {
            found: true,
            currentBuildNumber: buildInfo.buildNumber,
            latestBuildNumber: buildId,
            latestFullSha: sha,
            downloadUrl,
            filename: filename,
            lastModified: packageTimestamp,
            fileSize: pkg.size,
            checksum,
            updateSource: 'cloudsmith',
            updateChannel: updateChannel,
            updateChannelDisplay: getUpdateChannelDisplay(updateChannel),
            updateChannelLabel: getUpdateChannelLabel(updateChannel),
          };
          foundBuild.updateKey = buildUpdateGraceKey(foundBuild, updateChannel);
          return foundBuild;
        }
      }
    }

    // Build not found
    return {
      found: false,
      error: `Build ${buildId} not found`,
      updateChannel: updateChannel
    };

  } catch (error) {
    console.error('Failed to search for build:', error);
    return {
      found: false,
      error: error.message
    };
  }
}

// ============================================================================
// UPDATE EXECUTION HELPERS
// ============================================================================

/**
 * Run the update wrapper script (detached process that survives app exit)
 * @param {Object} updateInfo - Update info from checkForUpdates
 * @returns {Promise<Object>} - Result with success status
 */
async function runUpdateWrapper(updateInfo) {
  const PROJECT_ROOT = getProjectRoot();

  try {
    console.log('Update requested, starting update process...');

    let wrapperScript;
    let scriptArgs = [PROJECT_ROOT];

    // We need the update info from the check
    if (!updateInfo || !updateInfo.downloadUrl || !updateInfo.filename) {
      // If we don't have update info, get it now
      console.log('Update info not provided, checking for updates...');
      const latestUpdateInfo = await checkForUpdates();
      if (!latestUpdateInfo.updateAvailable) {
        return { success: false, error: 'No update available' };
      }
      updateInfo = latestUpdateInfo;
    }

    // Use update wrapper script
    const scriptsDir = path.join(PROJECT_ROOT, 'electron-app', 'src', 'scripts');
    wrapperScript = path.join(scriptsDir, 'update-wrapper-cloudsmith.sh');

    // Add download-specific arguments
    const resolvedFullSha = updateInfo.latestFullSha || updateInfo.fullSha || updateInfo.latestBuildNumber;
    scriptArgs.push(updateInfo.downloadUrl, updateInfo.filename, resolvedFullSha);

    // Ensure the script exists
    if (!fs.existsSync(wrapperScript)) {
      console.error('Update wrapper script not found at:', wrapperScript);
      return { success: false, error: `Update wrapper script not found: ${wrapperScript}` };
    }

    // Clear any existing update log
    const logFile = path.join(PROJECT_ROOT, 'electron-app', 'update.log');
    if (fs.existsSync(logFile)) {
      fs.unlinkSync(logFile);
    }

    // Get the loading window to show initial message
    if (state.windows.loading && !state.windows.loading.isDestroyed()) {
      const updateSource = 'Cloudsmith repository';
      state.windows.loading.webContents.send('loading-log-append', {
        text: `✅ Update process started (${updateSource}). The application will restart automatically.\n`,
        type: 'success'
      });
      state.windows.loading.webContents.send('loading-log-append', {
        text: '📋 Update logs will appear below:\n',
        type: 'info'
      });
      state.windows.loading.webContents.send('loading-log-append', {
        text: '________________________________\n\n',
        type: 'info'
      });

      // Start monitoring the log file
      let lastSize = 0;
      const logMonitor = setInterval(() => {
        if (fs.existsSync(logFile)) {
          const stats = fs.statSync(logFile);
          if (stats.size > lastSize) {
            const stream = fs.createReadStream(logFile, {
              start: lastSize,
              end: stats.size
            });
            stream.on('data', (chunk) => {
              const text = chunk.toString();
              const cleanText = text.replace(/\x1b\[[0-9;]*m/g, '');
              if (state.windows.loading && !state.windows.loading.isDestroyed()) {
                state.windows.loading.webContents.send('loading-log-append', {
                  text: cleanText,
                  type: 'info'
                });
              }
            });
            lastSize = stats.size;
          }
        }
      }, 500); // Check every 500ms

      // Stop monitoring after 30 seconds (should be enough time)
      setTimeout(() => {
        clearInterval(logMonitor);
      }, 30000);
    }

    // Run the wrapper script which will properly detach the update
    console.log('Running update script:', wrapperScript, 'with args:', scriptArgs);
    const child = spawn('bash', [wrapperScript, ...scriptArgs], {
      detached: true,
      stdio: 'ignore'
    });

    child.unref();
    console.log('Update wrapper started with PID:', child.pid);

    // Give the wrapper a moment to start
    await new Promise(resolve => setTimeout(resolve, 500));

    return {
      success: true,
      message: 'Update process started using cloudsmith method',
      updateSource: 'cloudsmith'
    };
  } catch (error) {
    console.error('Failed to start update process:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Execute update script with streaming output
 * @param {Object} updateInfo - Update info from checkForUpdates
 * @returns {Promise<Object>} - Result with success, output, and log file path
 */
function executeUpdate(updateInfo) {
  const PROJECT_ROOT = getProjectRoot();

  return new Promise((resolve) => {
    console.log('=== EXECUTE UPDATE START ===');
    console.log('Executing update with info:', updateInfo);
    console.log('Current working directory:', process.cwd());
    console.log('PROJECT_ROOT:', PROJECT_ROOT);

    // Use the managed directory for scripts
    const managedDir = path.join(os.homedir(), 'portico', 'portico-managed');
    console.log('Managed directory:', managedDir);
    console.log('Managed directory exists:', fs.existsSync(managedDir));

    const updateScript = path.join(PROJECT_ROOT, 'electron-app', 'src', 'scripts', 'update-in-app-cloudsmith.sh');
    const resolvedFullSha = updateInfo.fullSha || updateInfo.latestFullSha || updateInfo.latestBuildNumber;
    if (!updateInfo || !updateInfo.downloadUrl || !updateInfo.filename || !resolvedFullSha) {
      console.error('Missing required update info:', updateInfo);
      resolve({ success: false, error: 'Missing required update info' });
      return;
    }
    const scriptArgs = [managedDir, updateInfo.downloadUrl, updateInfo.filename, resolvedFullSha];
    const updateSource = updateInfo.updateSource || 'cloudsmith';
    console.log('Using Cloudsmith update script');

    console.log('Update script path:', updateScript);
    console.log('Update script exists:', fs.existsSync(updateScript));
    console.log('Script arguments:', scriptArgs);
    console.log('Executing from directory:', PROJECT_ROOT);

    // Setup comprehensive logging for the entire update process
    const logDir = path.join(os.homedir(), 'Library', 'Application Support', 'portico', 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const dateStr = new Date().toISOString().split('T')[0];
    const updateLogFile = path.join(logDir, `update-${dateStr}.log`);

    // Create write stream for logging
    const logStream = fs.createWriteStream(updateLogFile, { flags: 'a' });
    // PORTICO-215: keep an async ENOSPC on this stream from crashing the main
    // process as an uncaughtException; the update failure UX reports the
    // disk-full condition to the user.
    logStream.on('error', (error) => {
      console.error('[Update] update log stream error:', error?.message);
    });

    // Log header
    const logHeader = [
      '========================================',
      'Portico Update Process',
      `Started: ${new Date().toISOString()}`,
      `Update Source: ${updateSource}`,
      `Script: ${updateScript}`,
      `Arguments: ${scriptArgs.join(' ')}`,
      `Log File: ${updateLogFile}`,
      '========================================',
      ''
    ].join('\n');

    logStream.write(logHeader);
    console.log('📝 Update logs will be saved to:', updateLogFile);

    // Ensure Docker, OrbStack, and packaged runtime tools are in PATH.
    const enhancedEnv = createRuntimeShellEnv({
      baseEnv: process.env,
      overrides: {
        FORCE_COLOR: '1',
        TERM: 'xterm-256color'
      },
      isPackagedApp: app.isPackaged === true,
      resourcesPath: process.resourcesPath
    });

    // Execute update script
    console.log('Spawning bash process...');
    const child = spawn('bash', [updateScript, ...scriptArgs], {
      cwd: PROJECT_ROOT,
      env: enhancedEnv
    });

    console.log('Update process started with PID:', child.pid);

    let output = '';
    let errorOutput = '';
    let readyForRestart = false;

    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;

      // Write to log file
      logStream.write(text);

      // Log key lines to console for debugging
      const lines = text.split('\n');
      lines.forEach(line => {
        if (line.includes('Step') || line.includes('PWD') || line.includes('directory') || line.includes('Script')) {
          console.log('[UPDATE OUTPUT]', line.trim());
        }
      });

      // Check for restart signal
      if (text.includes('READY_FOR_RESTART')) {
        console.log('READY_FOR_RESTART signal received');
        readyForRestart = true;
      }

      // Send output to loading window
      if (state.windows.loading && !state.windows.loading.isDestroyed()) {
        state.windows.loading.webContents.send('update-output', { data: text, type: 'stdout' });
      }
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;

      // Write to log file (stderr)
      logStream.write(`[STDERR] ${text}`);

      console.log('[UPDATE ERROR]', text.trim());
      if (state.windows.loading && !state.windows.loading.isDestroyed()) {
        state.windows.loading.webContents.send('update-output', { data: text, type: 'stderr' });
      }
    });

    child.on('close', (code) => {
      console.log('=== UPDATE SCRIPT COMPLETED ===');
      console.log('Update script exited with code:', code);
      console.log('Ready for restart:', readyForRestart);

      // Log footer
      const logFooter = [
        '',
        '========================================',
        'Update Script Completed',
        `Finished: ${new Date().toISOString()}`,
        `Exit Code: ${code}`,
        `Ready for Restart: ${readyForRestart}`,
        `Log File: ${updateLogFile}`,
        '========================================',
        ''
      ].join('\n');

      logStream.write(logFooter);
      logStream.end();

      console.log('📝 Complete update log saved to:', updateLogFile);

      if (state.windows.loading && !state.windows.loading.isDestroyed()) {
        state.windows.loading.webContents.send('update-complete', {
          success: code === 0,
          code,
          readyForRestart
        });
      }

      resolve({
        success: code === 0,
        output,
        error: errorOutput,
        code,
        readyForRestart,
        logFile: updateLogFile
      });
    });

    child.on('error', (err) => {
      console.error('Update script error:', err);

      // Log error and close stream
      const errorLog = [
        '',
        '========================================',
        'Update Script Error',
        `Error: ${err.message}`,
        `Timestamp: ${new Date().toISOString()}`,
        `Log File: ${updateLogFile}`,
        '========================================',
        ''
      ].join('\n');

      logStream.write(errorLog);
      logStream.end();

      console.log('📝 Update error log saved to:', updateLogFile);

      if (state.windows.loading && !state.windows.loading.isDestroyed()) {
        state.windows.loading.webContents.send('update-complete', {
          success: false,
          error: err.message
        });
      }
      resolve({
        success: false,
        error: err.message,
        logFile: updateLogFile
      });
    });
  });
}

/**
 * Handle app restart after update - swap dist directories and relaunch
 * @returns {Object} - Result with success status
 */
function restartAfterUpdate() {
  console.log('=== RESTART AFTER UPDATE ===');
  console.log('Restarting app after update...');
  console.log('Current working directory:', process.cwd());

  // Use the managed directory for dist swapping
  const managedDir = path.join(os.homedir(), 'portico', 'portico-managed');
  console.log('Managed directory:', managedDir);

  const distPath = path.join(managedDir, 'electron-app', 'dist');
  const distUpdatePath = path.join(managedDir, 'electron-app', 'dist-update');
  const distBackupPath = path.join(managedDir, 'electron-app', 'dist-backup');

  console.log('Dist path:', distPath);
  console.log('Dist update path:', distUpdatePath);
  console.log('Dist backup path:', distBackupPath);
  console.log('Dist exists:', fs.existsSync(distPath));
  console.log('Dist-update exists:', fs.existsSync(distUpdatePath));
  console.log('Dist-backup exists:', fs.existsSync(distBackupPath));

  const removePathBestEffort = (targetPath) => {
    if (!fs.existsSync(targetPath)) {
      return true;
    }

    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return true;
    } catch (error) {
      console.warn(`[Restart] fs.rmSync failed for ${targetPath}, falling back to rm -rf:`, error.message);
    }

    try {
      const rmResult = spawnSync('rm', ['-rf', targetPath], { stdio: 'ignore' });
      return rmResult.status === 0 || !fs.existsSync(targetPath);
    } catch (error) {
      console.warn(`[Restart] rm -rf fallback failed for ${targetPath}:`, error.message);
      return false;
    }
  };

  try {
    // Backup current dist
    if (fs.existsSync(distPath)) {
      console.log('Backing up current dist...');
      if (fs.existsSync(distBackupPath)) {
        console.log('Removing old backup...');
        if (!removePathBestEffort(distBackupPath)) {
          const staleBackupPath = `${distBackupPath}-stale-${Date.now()}`;
          console.warn(`[Restart] Could not delete old backup, moving it to ${staleBackupPath}`);
          fs.renameSync(distBackupPath, staleBackupPath);
        }
      }
      console.log('Moving dist to dist-backup...');
      fs.renameSync(distPath, distBackupPath);
      console.log('Backup completed');
    }

    // Move dist-update to dist
    if (fs.existsSync(distUpdatePath)) {
      console.log('Moving dist-update to dist...');
      fs.renameSync(distUpdatePath, distPath);
      console.log('Move completed');
    } else {
      console.log('WARNING: dist-update does not exist!');
    }

    // Clean up backup
    if (fs.existsSync(distBackupPath)) {
      console.log('Cleaning up backup...');
      if (removePathBestEffort(distBackupPath)) {
        console.log('Backup cleaned');
      } else {
        console.warn('[Restart] Backup cleanup failed; continuing with relaunch');
      }
    }

    // Restart the app
    console.log('Relaunching application...');
    app.relaunch();
    tagAppQuit('legacy-update-relaunch');
    app.quit();

    return { success: true };
  } catch (error) {
    console.error('=== RESTART FAILED ===');
    console.error('Failed to restart after update:', error);
    console.error('Error stack:', error.stack);
    return { success: false, error: error.message };
  }
}

/**
 * Show update dialog from main window
 * @param {Object} updateInfo - Update info from checkForUpdates
 * @param {Function} getCurrentChannel - Function to get current channel
 * @param {Function} createLoadingWindow - Function to create loading window
 * @returns {Promise<Object>} - Result with success and accepted status
 */
async function showUpdateDialog(updateInfo, getCurrentChannel, createLoadingWindow) {
  console.log('Showing update dialog from main window with info:', updateInfo);

  try {
    const currentBuild = updateInfo.currentBuildNumber || 'unknown';
    const latestBuild = updateInfo.latestBuildNumber || 'unknown';
    const currentChannel = typeof getCurrentChannel === 'function'
      ? getCurrentChannel()
      : null;
    const channelInfo = resolveReleaseChannelPackage(updateInfo.updateChannel, {
      allowLegacy: true,
    }) || resolveReleaseChannelName(currentChannel) || getDefaultReleaseChannel();
    const channelLabel = channelInfo.label;

    // Show the same native dialog as on startup
    const result = await dialog.showMessageBox(state.windows.main, {
      type: 'info',
      title: 'Update Available',
      message: `A new version is available: ${latestBuild}`,
      detail: `Release channel: ${channelLabel}\n\nCurrent version: ${currentBuild}\nNew version: ${latestBuild}\n\nWould you like to update now?`,
      buttons: ['Later', 'Update Now'],
      defaultId: 1,
      cancelId: 0,
      icon: getThemeIcon()
    });

    if (result.response === 1) { // User clicked "Update Now"
      console.log('User accepted update from main window, starting update process...');

      // Close the main window
      if (state.windows.main && !state.windows.main.isDestroyed()) {
        state.windows.main.close();
        state.windows.main = null;
      }

      // Create loading window with update info, skipping update check since we just did it
      // Pass the update info directly so it starts the update immediately
      if (!state.windows.loading || state.windows.loading.isDestroyed()) {
        createLoadingWindow(true, updateInfo);  // Pass true to skip check AND the update info
      }

      return { success: true, accepted: true };
    } else {
      console.log('User chose to update later');
      return { success: true, accepted: false };
    }
  } catch (error) {
    console.error('Failed to show update dialog:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// MIGRATION: guided-setup → electron-app
// ============================================================================
// Old builds used guided-setup/ folder. New builds use electron-app/.
// This function nukes the old guided-setup folder and relaunches from the
// canonical electron-app/dist path if needed.
//
// Note: macOS does NOT follow symlinks for dock shortcuts, so there's no point
// in preserving guided-setup with symlinks. Just delete it.

/**
 * Perform migration from guided-setup to electron-app folder structure
 * If guided-setup exists:
 *   1. Delete the guided-setup folder entirely
 *   2. Rename electron-app/dist-update to electron-app/dist (if dist-update exists)
 *   3. Spawn a NEW app process from canonical path using 'open' command
 *   4. Exit current process with app.exit(0)
 * @returns {Promise<void>}
 */
async function performMigrationIfNeeded() {
  const managedDir = path.join(os.homedir(), 'portico', 'portico-managed');
  const guidedSetupDir = path.join(managedDir, 'guided-setup');
  const electronAppDir = path.join(managedDir, 'electron-app');
  const electronAppDist = path.join(electronAppDir, 'dist');
  const electronAppDistUpdate = path.join(electronAppDir, 'dist-update');

  console.log('[Migration] Checking if migration is needed...');

  // Only migrate if guided-setup folder exists
  if (!fs.existsSync(guidedSetupDir)) {
    console.log('[Migration] No guided-setup folder found - no migration needed');
    return;
  }

  console.log('[Migration] Found guided-setup folder - performing migration');

  // Step 1: Delete guided-setup folder
  try {
    const cleanupResult = removeLegacyGuidedSetupDir(managedDir);
    if (cleanupResult.removed) {
      console.log('[Migration] Deleted guided-setup folder');
    } else {
      console.warn('[Migration] guided-setup folder still exists after cleanup');
    }
  } catch (err) {
    console.error('[Migration] Failed to delete guided-setup:', err.message);
  }

  // Step 2: Rename dist-update to dist (if dist-update exists)
  if (fs.existsSync(electronAppDistUpdate)) {
    console.log('[Migration] Found dist-update - normalizing to dist');

    if (fs.existsSync(electronAppDist)) {
      try {
        fs.rmSync(electronAppDist, { recursive: true, force: true });
        console.log('[Migration] Removed stale dist');
      } catch (err) {
        console.error('[Migration] Failed to remove stale dist:', err.message);
      }
    }

    try {
      fs.renameSync(electronAppDistUpdate, electronAppDist);
      console.log('[Migration] Renamed dist-update to dist');
    } catch (err) {
      console.error('[Migration] Failed to rename:', err.message);
    }
  }

  // Step 3: Determine the app bundle path and launch fresh process
  // Detect architecture: mac-arm64 (Apple Silicon) or mac (Intel)
  const arch = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  const appBundlePath = path.join(electronAppDist, arch, 'Portico.app');

  console.log('[Migration] App bundle path:', appBundlePath);

  if (fs.existsSync(appBundlePath)) {
    console.log('[Migration] Launching fresh app process...');

    // Use macOS 'open' command to launch the app bundle
    // -n flag opens a new instance even if app is already running
    const child = spawn('open', ['-n', appBundlePath], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    console.log('[Migration] Fresh process spawned, exiting current process...');
    tagAppQuit('migration-relaunch');
    app.exit(0);
  } else {
    console.error('[Migration] App bundle not found at:', appBundlePath);
    // Don't exit - let app try to continue
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Channel utilities
  getUpdateChannel,
  getUpdateChannelInfo,

  // Version comparison
  isNewerVersion,

  // Timestamp tracking for same-build re-upload detection
  getLastInstalledTimestampPath,
  readLastInstalledBuildState,
  readLastInstalledTimestamp,
  saveLastInstalledBuildState,
  saveLastInstalledTimestamp,

  // One-time update grace state
  UPDATE_GRACE_DURATION_MS,
  getUpdateGraceStatePath,
  readUpdateGraceState,
  writeUpdateGraceState,
  buildUpdateGraceKey,
  canOfferOneTimeUpdateGrace,
  consumeOneTimeUpdateGrace,
  clearUpdateGraceState,

  // Update checking
  checkForUpdates,
  findSpecificBuild,

  // Update execution
  runUpdateWrapper,
  executeUpdate,
  restartAfterUpdate,
  showUpdateDialog,

  // Migration
  performMigrationIfNeeded,

  _test: {
    buildCloudsmithDownloadUrl,
    parsePackageBuildInfo,
  },
};
