const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');

const repoRoot = path.resolve(__dirname, '..', '..');
const updatesPath = path.join(repoRoot, 'electron-app', 'src', 'services', 'updates.js');
const bootstrapPath = path.join(repoRoot, 'electron-app', 'src', 'services', 'bootstrap.js');
const sharedStatePath = path.join(repoRoot, 'electron-app', 'src', 'services', 'shared-state.js');
const configPath = path.join(repoRoot, 'electron-app', 'src', 'config', 'cloudsmith-config.js');

const electronStub = {
  app: {
    exit() {},
    isPackaged: false,
    getPath() { return ''; },
    getAppPath() { return ''; },
    isReady() { return true; }
  },
  dialog: {
    showErrorBox() {},
    showMessageBoxSync() { return 0; }
  },
  BrowserWindow: function BrowserWindow() {},
  shell: { openExternal() {} },
  Menu: { buildFromTemplate() { return {}; }, setApplicationMenu() {} },
  nativeTheme: { shouldUseDarkColors: false },
  session: { defaultSession: {} }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return electronStub;
  }
  return originalLoad.apply(this, arguments);
};

function buildPackage(channel, buildId, uploadedAt, overrides = {}) {
  const filename = overrides.filename || `${channel}-${buildId}.zip`;
  return {
    name: channel,
    version: buildId,
    filename,
    uploaded_at: uploadedAt,
    size: 123,
    checksum_sha256: `sha256-${buildId}`,
    tags_immutable: { info: ['portico-update-ready-v1'] },
    ...overrides,
  };
}

function buildCanonicalRawUrl(port, channel, version, filename) {
  return `http://127.0.0.1:${port}/TESTTOKEN/portico/raw/names/${channel}/versions/${version}/${filename}`;
}

function createServer(options) {
  const {
    packages,
    pageSize = 100,
    pageResponses = {},
    outOfRangeStatus = 200,
    expectedApiKey = 'TEST_API_KEY',
  } = Array.isArray(options) ? { packages: options } : options;
  const requestLog = [];

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');

    if (requestUrl.pathname === '/api/v1/packages/portico/portico/') {
      const query = requestUrl.searchParams.get('query') || '';
      const page = Number(requestUrl.searchParams.get('page') || '1');
      const apiKey = req.headers['x-api-key'] || '';
      requestLog.push({ pathname: requestUrl.pathname, page, query, apiKey });

      if (expectedApiKey && apiKey !== expectedApiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Unauthorized' }));
        return;
      }

      const customResponse = pageResponses[page] || pageResponses[String(page)];
      if (customResponse) {
        const status = customResponse.status ?? 200;
        const headers = customResponse.headers || (status === 200 ? { 'Content-Type': 'application/json' } : {});
        const body = customResponse.body;

        res.writeHead(status, headers);
        if (body === undefined) {
          res.end(status === 200 ? JSON.stringify([]) : '');
        } else if (typeof body === 'string') {
          res.end(body);
        } else {
          res.end(JSON.stringify(body));
        }
        return;
      }

      const nameMatch = query.match(/name:\^?([^ $]+)\$?/);
      const channel = nameMatch ? decodeURIComponent(nameMatch[1]) : null;
      // PORTICO-438: honour the readiness clause the client actually sends, so the
      // PORTICO-409 gate is exercised here rather than ignored.
      //
      // Cloudsmith's `tag:` search does not distinguish mutable from immutable
      // tags, so this matches either -- which is precisely why the client
      // re-checks `tags_immutable` itself (isUpdateReadyPackage, tightened by
      // b28d4bf0). Filtering only on immutable here would model the API wrongly
      // and hide that client-side check.
      const requiresReady = /tag:\^?portico-update-ready-v1/.test(query);
      const filtered = packages.filter((pkg) => {
        if (channel && pkg.name !== channel) {
          return false;
        }
        if (!requiresReady) {
          return true;
        }
        const allTags = [
          ...Object.values(pkg.tags || {}).flat(),
          ...Object.values(pkg.tags_immutable || {}).flat(),
        ];
        return allTags.includes('portico-update-ready-v1');
      });
      const pageStart = (page - 1) * pageSize;
      const payload = filtered.slice(pageStart, pageStart + pageSize);

      if (payload.length === 0 && page > 1 && outOfRangeStatus !== 200) {
        res.writeHead(outOfRangeStatus);
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (requestUrl.pathname.startsWith('/api/v2/metadata/packages/')) {
      requestLog.push({
        pathname: requestUrl.pathname,
        metadata: true,
        xApiKey: req.headers['x-api-key'] || null,
      });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'metadata endpoint must not be used' }));
      return;
    }

    if (requestUrl.pathname.startsWith('/TESTTOKEN/portico/raw/names/')) {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end('zip-bytes');
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      server.requestLog = requestLog;
      resolve(server);
    });
  });
}

function buildPackageBatch(channel, count, buildDate = '03152026') {
  const startMs = Date.UTC(2026, 2, 6, 12, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const sha = index.toString(16).padStart(8, '0');
    const uploadedAt = new Date(startMs - (index * 60_000)).toISOString();
    return buildPackage(channel, `${buildDate}-${sha}`, uploadedAt);
  });
}

function loadUpdates({
  homeDir,
  projectRoot,
  currentBuild,
  currentBuildTimestamp = null,
  port,
  apiKey = 'TEST_API_KEY',
  entitlementToken = 'TESTTOKEN',
}) {
  process.env.HOME = homeDir;

  require.cache[bootstrapPath] = {
    id: bootstrapPath,
    filename: bootstrapPath,
    loaded: true,
    exports: {
      PROJECT_ROOT: projectRoot,
      getThemeIcon() { return ''; }
    }
  };

  require.cache[sharedStatePath] = {
    id: sharedStatePath,
    filename: sharedStatePath,
    loaded: true,
    exports: {
      buildInfo: {
        buildNumber: currentBuild,
        date: 'unknown',
        fullSha: 'unknown',
        channel: 'unknown',
        timestamp: currentBuildTimestamp,
      },
      windows: {},
      appState: {}
    }
  };

  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
      CLOUDSMITH_OWNER: 'portico',
      CLOUDSMITH_REPO: 'portico',
      CLOUDSMITH_API_BASE: `http://127.0.0.1:${port}/api/v1`,
      CLOUDSMITH_API_V2_BASE: `http://127.0.0.1:${port}/api/v2`,
      CLOUDSMITH_DL_BASE: `http://127.0.0.1:${port}`,
      CLOUDSMITH_API_KEY: apiKey,
      CLOUDSMITH_READ_TOKEN: apiKey,
      CLOUDSMITH_ENTITLEMENT_TOKEN: entitlementToken,
    }
  };

  delete require.cache[updatesPath];
  return require(updatesPath);
}

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-test-'));
}

function getLastInstalledBuildPath(homeDir) {
  return path.join(
    homeDir,
    'Library',
    'Application Support',
    'portico',
    'LAST_INSTALLED_BUILD',
  );
}

function writeLastInstalledBuildState(homeDir, buildNumber, timestamp) {
  const statePath = getLastInstalledBuildPath(homeDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({ schemaVersion: 1, buildNumber, timestamp }, null, 2)}\n`,
    'utf8',
  );
}

function writeLegacyLastInstalledTimestamp(homeDir, timestamp) {
  const statePath = getLastInstalledBuildPath(homeDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, timestamp, 'utf8');
}

function writeUpdateChannel(projectRoot, channel) {
  fs.writeFileSync(path.join(projectRoot, 'UPDATE_CHANNEL'), channel, 'utf8');
}

function readUpdateChannel(projectRoot) {
  const updateChannelPath = path.join(projectRoot, 'UPDATE_CHANNEL');
  return fs.existsSync(updateChannelPath)
    ? fs.readFileSync(updateChannelPath, 'utf8').trim()
    : null;
}

function buildRoutingTags(redirectChannel, extraTags = []) {
  return {
    info: [
      'portico-routing-v1',
      'portico-eol-true',
      'portico-force-update-true',
      `portico-redirect-${redirectChannel}`,
      'portico-update-ready-v1',
      ...extraTags,
    ],
  };
}

function hasMetadataRequest(server) {
  return server.requestLog.some(entry => entry.metadata);
}

async function testUploadedAtSameBuildRepublish() {
  const stable = 'portico';
  const packages = [
    buildPackage(stable, '03152026-bbbbbbbb', '2026-03-06T12:05:00.000Z'),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeLastInstalledBuildState(
      homeDir,
      '03152026-bbbbbbbb',
      '2026-03-06T12:01:00.000Z',
    );

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03152026-bbbbbbbb',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(result.timestampUpdate, true);
    assert.equal(result.lastModified, '2026-03-06T12:05:00.000Z');
    assert.equal(result.latestBuildNumber, '03152026-bbbbbbbb');
    assert.deepEqual(result.checksum, {
      sha256: 'sha256-03152026-bbbbbbbb',
    });
    assert.equal(
      result.updateKey,
      '03152026-bbbbbbbb|sha256:sha256-03152026-bbbbbbbb|portico',
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testSameDayOlderUploadDoesNotDowngrade() {
  const channel = 'portico_dev';
  const packages = [
    buildPackage(channel, '06182026-1212102f', '2026-06-18T23:48:07.000Z'),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    fs.writeFileSync(path.join(projectRoot, 'UPDATE_CHANNEL'), `${channel}\n`, 'utf8');

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '06182026-e2605e23',
      currentBuildTimestamp: '2026-06-19T02:15:13.000Z',
      port,
    });
    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.equal(result.currentBuildNumber, '06182026-e2605e23');
    assert.equal(result.latestBuildNumber, '06182026-1212102f');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testSameDayNewerUploadIsEligible() {
  const channel = 'portico_dev';
  const packages = [
    buildPackage(channel, '06182026-bbbbbbbb', '2026-06-19T02:20:00.000Z'),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    fs.writeFileSync(path.join(projectRoot, 'UPDATE_CHANNEL'), `${channel}\n`, 'utf8');

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '06182026-aaaaaaaa',
      currentBuildTimestamp: '2026-06-19T02:15:00.000Z',
      port,
    });
    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(result.latestBuildNumber, '06182026-bbbbbbbb');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testNewestUnreadyPackageDoesNotHidePriorReadyRelease() {
  const channel = 'portico_dev';
  const packages = [
    buildPackage(channel, '06192026-cccccccc', '2026-06-19T03:00:00.000Z', {
      tags: { info: [] },
      tags_immutable: { info: [] },
    }),
    buildPackage(channel, '06192026-bbbbbbbb', '2026-06-19T02:20:00.000Z', {
      tags: { info: [] },
      tags_immutable: { info: ['portico-update-ready-v1'] },
    }),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeUpdateChannel(projectRoot, channel);
    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '06182026-aaaaaaaa',
      currentBuildTimestamp: '2026-06-19T02:15:00.000Z',
      port,
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(result.latestBuildNumber, '06192026-bbbbbbbb');
    assert.match(server.requestLog[0].query, /tag:\^portico-update-ready-v1\$/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testMutableReadyTagDoesNotProduceAutomaticUpdate() {
  const channel = 'portico_dev';
  const packages = [
    buildPackage(channel, '06192026-bbbbbbbb', '2026-06-19T02:20:00.000Z', {
      tags_immutable: { info: [] },
      tags: { info: ['portico-update-ready-v1'] },
    }),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeUpdateChannel(projectRoot, channel);
    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '06182026-aaaaaaaa',
      currentBuildTimestamp: '2026-06-19T02:15:00.000Z',
      port,
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.equal(result.pendingPublication, true);
    assert.equal(result.error, undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testSameDayDifferentShaRequiresTrustedLocalTimestamp() {
  const stable = 'portico';
  const packages = [
    buildPackage(stable, '03152026-bbbbbbbb', '2026-03-15T12:05:00.000Z'),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03152026-aaaaaaaa',
      port,
    });
    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function testSameDayVersionComparisonRejectsInvalidTimestamps() {
  const currentBuild = '03152026-aaaaaaaa';
  const latestBuild = '03152026-bbbbbbbb';
  const updates = loadUpdates({
    homeDir: makeTempHome(),
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-')),
    currentBuild,
    port: 1,
  });

  assert.equal(updates.isNewerVersion(currentBuild, latestBuild), false);
  assert.equal(
    updates.isNewerVersion(currentBuild, latestBuild, {
      currentTimestamp: 'not-a-timestamp',
      latestTimestamp: '2026-03-15T12:05:00.000Z',
    }),
    false,
  );
  assert.equal(
    updates.isNewerVersion(currentBuild, latestBuild, {
      currentTimestamp: '2026-03-15T12:00:00.000Z',
      latestTimestamp: '2026-03-15T12:05:00.000Z',
    }),
    true,
  );
}

function testSentinelCandidateIsNeverNewer() {
  const updates = loadUpdates({
    homeDir: makeTempHome(),
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-')),
    currentBuild: '06192026-3409362c',
    port: 1,
  });

  assert.equal(
    updates.isNewerVersion('06192026-3409362c', '99999999-ffffffff'),
    false,
  );
  assert.equal(updates.isNewerVersion('unknown', '99999999-ffffffff'), false);
  assert.equal(updates.isNewerVersion('dev-build', '99999999-ffffffff'), false);
  assert.equal(
    updates.isNewerVersion('99999999-ffffffff', '01132026-11111111'),
    true,
  );
}

function testInstalledStateIsBuildBoundJson() {
  const homeDir = makeTempHome();
  const updates = loadUpdates({
    homeDir,
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-')),
    currentBuild: '06192026-8ea7bf69',
    port: 1,
  });

  assert.equal(
    updates.saveLastInstalledBuildState(
      '06192026-8ea7bf69',
      '2026-06-19T22:58:49.711054Z',
    ),
    true,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(getLastInstalledBuildPath(homeDir), 'utf8')),
    {
      schemaVersion: 1,
      buildNumber: '06192026-8ea7bf69',
      timestamp: '2026-06-19T22:58:49.711054Z',
    },
  );
  assert.deepEqual(updates.readLastInstalledBuildState(), {
    schemaVersion: 1,
    buildNumber: '06192026-8ea7bf69',
    timestamp: '2026-06-19T22:58:49.711054Z',
    legacy: false,
  });
}

async function testStoredInstallTimestampTakesPrecedenceOverOlderBuildTimestamp() {
  const stable = 'portico';
  const packages = [
    buildPackage(stable, '03152026-bbbbbbbb', '2026-03-15T12:05:00.000Z'),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeLastInstalledBuildState(
      homeDir,
      '03152026-aaaaaaaa',
      '2026-03-15T12:10:00.000Z',
    );
    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03152026-aaaaaaaa',
      currentBuildTimestamp: '2026-03-15T12:00:00.000Z',
      port,
    });
    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testModernBuildIgnoresSentinelAndStaysOnSameBuild() {
  const channel = 'portico_dev';
  const currentBuild = '06192026-3409362c';
  const packages = [
    buildPackage(channel, '99999999-ffffffff', '2026-03-06T20:28:30.423Z'),
    buildPackage(channel, currentBuild, '2026-06-19T16:29:05.000Z'),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    fs.writeFileSync(path.join(projectRoot, 'UPDATE_CHANNEL'), `${channel}\n`, 'utf8');
    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild,
      currentBuildTimestamp: '2026-06-19T16:29:05.000Z',
      port,
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.equal(result.latestBuildNumber, currentBuild);
    assert.equal(result.filename, `${channel}-${currentBuild}.zip`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testExactInstalledPackagePreventsSameDayDowngradeWithLegacyTimestamp() {
  const channel = 'portico_dev';
  const currentBuild = '06192026-8ea7bf69';
  const olderBuild = '06192026-3409362c';
  const packages = [
    buildPackage(channel, olderBuild, '2026-06-19T22:08:34.754883Z'),
    buildPackage(channel, currentBuild, '2026-06-19T22:58:49.711054Z'),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    fs.writeFileSync(path.join(projectRoot, 'UPDATE_CHANNEL'), `${channel}\n`, 'utf8');
    writeLegacyLastInstalledTimestamp(homeDir, '2026-06-17T19:36:14.035262Z');
    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild,
      currentBuildTimestamp: '2026-06-19T22:33:21.000Z',
      port,
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.equal(result.latestBuildNumber, currentBuild);
    assert.equal(result.filename, `${channel}-${currentBuild}.zip`);
    assert.deepEqual(updates.readLastInstalledBuildState(), {
      schemaVersion: 1,
      buildNumber: currentBuild,
      timestamp: '2026-06-19T22:58:49.711054Z',
      legacy: false,
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testModernBuildIgnoresSentinelAndSelectsNewerRelease() {
  const channel = 'portico_dev';
  const currentBuild = '06192026-3409362c';
  const newerBuild = '06202026-11111111';
  const packages = [
    buildPackage(channel, '99999999-ffffffff', '2026-03-06T20:28:30.423Z'),
    buildPackage(channel, currentBuild, '2026-06-19T16:29:05.000Z'),
    buildPackage(channel, newerBuild, '2026-06-20T12:00:00.000Z'),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    fs.writeFileSync(path.join(projectRoot, 'UPDATE_CHANNEL'), `${channel}\n`, 'utf8');
    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild,
      currentBuildTimestamp: '2026-06-19T16:29:05.000Z',
      port,
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(result.latestBuildNumber, newerBuild);
    assert.equal(result.filename, `${channel}-${newerBuild}.zip`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testSentinelOnlyRepositoryDoesNotOfferUpdate() {
  const channel = 'portico_dev';
  const currentBuild = '06192026-3409362c';
  const packages = [
    buildPackage(channel, '99999999-ffffffff', '2026-03-06T20:28:30.423Z'),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    fs.writeFileSync(path.join(projectRoot, 'UPDATE_CHANNEL'), `${channel}\n`, 'utf8');
    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild,
      port,
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.equal(result.currentBuildNumber, currentBuild);
    assert.equal(result.error, undefined);
    assert.equal(result.latestBuildNumber, undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testBridgeBuildPrefersNewestValidRescueTarget() {
  const stable = 'portico';
  const packages = [
    buildPackage(stable, '99999999-ffffffff', '2026-03-06T12:10:00.000Z'),
    buildPackage(stable, '01132026-11111111', '2026-03-06T12:01:00.000Z'),
    buildPackage(stable, '01122026-22222222', '2026-03-06T12:09:00.000Z'),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '99999999-ffffffff',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(result.latestBuildNumber, '01132026-11111111');
    assert.equal(result.filename, 'portico-01132026-11111111.zip');
    assert.match(result.downloadUrl, /01132026-11111111/);
    assert.deepEqual(result.checksum, {
      sha256: 'sha256-01132026-11111111',
    });
    assert.equal(
      result.updateKey,
      '01132026-11111111|sha256:sha256-01132026-11111111|portico',
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testShortFirstPageStopsPaginationBefore404() {
  const stable = 'portico';
  const packages = buildPackageBatch(stable, 5);
  const server = await createServer({
    packages,
    outOfRangeStatus: 404,
  });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(result.latestBuildNumber, packages[0].version);
    assert.equal(server.requestLog.length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testLaterPage404EndsPaginationGracefully() {
  const stable = 'portico';
  const packages = buildPackageBatch(stable, 100);
  const server = await createServer({
    packages,
    outOfRangeStatus: 404,
  });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(result.latestBuildNumber, packages[0].version);
    assert.equal(server.requestLog.length, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testCheckForUpdatesFallsBackFromUnexpectedCdnUrl() {
  const stable = 'portico';
  const buildId = '03152026-aaaaaaaa';
  const packages = [
    buildPackage(stable, buildId, '2026-03-06T12:05:00.000Z', {
      cdn_url: 'http://127.0.0.1:0/TESTTOKEN/portico/bad-short-url.zip',
      tags: { info: ['portico-update-ready-v1'] },
    }),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    packages[0].cdn_url = `http://127.0.0.1:${port}/TESTTOKEN/portico/${packages[0].filename}`;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(
      result.downloadUrl,
      buildCanonicalRawUrl(port, stable, buildId, packages[0].filename),
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testCheckForUpdatesPreservesValidRawCdnUrl() {
  const stable = 'portico';
  const buildId = '03152026-aaaaaaaa';
  const packages = [
    buildPackage(stable, buildId, '2026-03-06T12:05:00.000Z'),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    packages[0].cdn_url =
      `http://127.0.0.1:${port}/basic/portico/raw/names/${stable}/versions/${buildId}/${packages[0].filename}`;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(
      result.downloadUrl,
      buildCanonicalRawUrl(port, stable, buildId, packages[0].filename),
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testFindSpecificBuildFallsBackFromUnexpectedCdnUrl() {
  const stable = 'portico';
  const buildId = '03152026-aaaaaaaa';
  const packages = [
    buildPackage(stable, buildId, '2026-03-06T12:05:00.000Z', {
      cdn_url: 'http://127.0.0.1:0/TESTTOKEN/portico/bad-short-url.zip',
    }),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    packages[0].cdn_url = `http://127.0.0.1:${port}/TESTTOKEN/portico/${packages[0].filename}`;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.findSpecificBuild(buildId);

    assert.equal(result.found, true);
    assert.doesNotMatch(server.requestLog[0].query, /portico-update-ready-v1/);
    assert.equal(
      result.downloadUrl,
      buildCanonicalRawUrl(port, stable, buildId, packages[0].filename),
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testFindSpecificBuildRejectsSentinelWithoutRequest() {
  const stable = 'portico';
  const sentinelBuild = '99999999-ffffffff';
  const server = await createServer([
    buildPackage(stable, sentinelBuild, '2026-03-06T20:28:30.423Z'),
  ]);

  try {
    const port = server.address().port;
    const updates = loadUpdates({
      homeDir: makeTempHome(),
      projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-')),
      currentBuild: '06192026-3409362c',
      port,
    });

    const result = await updates.findSpecificBuild(sentinelBuild);

    assert.equal(result.found, false);
    assert.match(result.error, /Legacy bridge builds cannot be installed/);
    assert.equal(server.requestLog.length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testCheckForUpdatesSkipsPackagesWithoutUsableDownloadUrl() {
  const stable = 'portico';
  const newerBuildId = '03162026-aaaaaaaa';
  const fallbackBuildId = '03152026-bbbbbbbb';
  const packages = [
    buildPackage(stable, newerBuildId, '2026-03-06T12:06:00.000Z', {
      version: '',
      cdn_url: 'http://127.0.0.1:0/TESTTOKEN/portico/bad-short-url.zip',
    }),
    buildPackage(stable, fallbackBuildId, '2026-03-06T12:05:00.000Z'),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    packages[0].cdn_url = `http://127.0.0.1:${port}/TESTTOKEN/portico/${packages[0].filename}`;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(result.latestBuildNumber, fallbackBuildId);
    assert.equal(
      result.downloadUrl,
      buildCanonicalRawUrl(port, stable, fallbackBuildId, packages[1].filename),
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testDevChannelUsesApiKeyForDiscoveryAndEntitlementForDownload() {
  const channel = 'portico_dev';
  const currentBuild = '06172026-979e6db7';
  const latestBuild = '06182026-1212102f';
  const packages = [
    buildPackage(channel, latestBuild, '2026-06-18T23:48:07.000Z'),
  ];
  const server = await createServer({ packages });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    fs.writeFileSync(path.join(projectRoot, 'UPDATE_CHANNEL'), `${channel}\n`, 'utf8');

    const updates = loadUpdates({ homeDir, projectRoot, currentBuild, port });
    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(result.currentBuildNumber, currentBuild);
    assert.equal(result.latestBuildNumber, latestBuild);
    assert.equal(server.requestLog.length, 1);
    assert.equal(server.requestLog[0].apiKey, 'TEST_API_KEY');
    assert.equal(
      result.downloadUrl,
      buildCanonicalRawUrl(port, channel, latestBuild, packages[0].filename),
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testMissingApiKeyFailsBeforeCloudsmithRequest() {
  const server = await createServer({ packages: [] });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '06172026-979e6db7',
      port,
      apiKey: '',
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.match(result.error, /Cloudsmith API key is not configured/);
    assert.equal(server.requestLog.length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testCloudsmithApi401RemainsAnError() {
  const server = await createServer({
    packages: [],
    expectedApiKey: 'EXPECTED_API_KEY',
  });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '06172026-979e6db7',
      port,
      apiKey: 'WRONG_API_KEY',
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.match(result.error, /Cloudsmith API request failed: 401 Unauthorized/);
    assert.equal(server.requestLog.length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testFirstPage404RemainsAnError() {
  const server = await createServer({
    packages: [],
    pageResponses: {
      1: { status: 404 }
    }
  });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.match(result.error, /Cloudsmith API request failed: 404 Not Found/);
    assert.equal(server.requestLog.length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testEntitlementTokenIsNotUsedAsApiKeyForDiscovery() {
  const stable = 'portico';
  const packages = [
    buildPackage(stable, '03152026-aaaaaaaa', '2026-03-06T12:05:00.000Z'),
  ];
  const server = await createServer(packages);

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port,
      apiKey: '',
      entitlementToken: 'TESTTOKEN',
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.match(result.error, /Cloudsmith API key is not configured/);
    assert.equal(server.requestLog.length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testEolRedirectsToTargetLatestAndPersistsChannel() {
  const beta = 'portico_beta';
  const dev = 'portico_dev';
  const betaBuild = '03152026-aaaaaaaa';
  const devBuild = '03162026-bbbbbbbb';
  const packages = [
    buildPackage(beta, betaBuild, '2026-03-06T12:05:00.000Z', {
      slug_perm: 'beta-slug',
      tags: buildRoutingTags(dev),
    }),
    buildPackage(dev, devBuild, '2026-03-06T12:06:00.000Z', { slug_perm: 'dev-slug' }),
  ];
  const server = await createServer({ packages });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeUpdateChannel(projectRoot, beta);

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: betaBuild,
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(result.forceUpdate, true);
    assert.equal(result.latestBuildNumber, devBuild);
    assert.equal(result.updateChannel, dev);
    assert.equal(result.updateChannelDisplay, 'dev');
    assert.equal(result.eolRedirect.fromChannel, beta);
    assert.equal(result.eolRedirect.toChannel, dev);
    assert.equal(result.eolRedirect.fromBuildNumber, betaBuild);
    assert.equal(result.eolRedirect.toBuildNumber, devBuild);
    assert.equal(result.eolRedirect.reason, '');
    assert.equal(readUpdateChannel(projectRoot), dev);
    assert.equal(hasMetadataRequest(server), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testEolRedirectForcesSameBuildDifferentChannel() {
  const beta = 'portico_beta';
  const dev = 'portico_dev';
  const buildId = '03152026-aaaaaaaa';
  const packages = [
    buildPackage(beta, buildId, '2026-03-06T12:05:00.000Z', {
      slug_perm: 'beta-slug',
      tags: buildRoutingTags(dev),
    }),
    buildPackage(dev, buildId, '2026-03-06T12:06:00.000Z', { slug_perm: 'dev-slug' }),
  ];
  const server = await createServer({ packages });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeUpdateChannel(projectRoot, beta);
    writeLastInstalledBuildState(homeDir, buildId, '2026-03-06T12:06:00.000Z');

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: buildId,
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(result.forceUpdate, true);
    assert.equal(result.timestampUpdate, undefined);
    assert.equal(result.latestBuildNumber, buildId);
    assert.equal(result.updateChannel, dev);
    assert.equal(readUpdateChannel(projectRoot), dev);
    assert.equal(hasMetadataRequest(server), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testInvalidEolTagsDoNotPersistRedirect() {
  const beta = 'portico_beta';
  const packages = [
    buildPackage(beta, '03152026-aaaaaaaa', '2026-03-06T12:05:00.000Z', {
      slug_perm: 'beta-slug',
      tags: buildRoutingTags('not a package name'),
    }),
  ];
  const server = await createServer({ packages });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeUpdateChannel(projectRoot, beta);

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.match(result.error, /routing redirect tag is invalid/);
    assert.equal(readUpdateChannel(projectRoot), beta);
    assert.equal(hasMetadataRequest(server), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testMissingForceEolTagsDoNotPersistRedirect() {
  const beta = 'portico_beta';
  const packages = [
    buildPackage(beta, '03152026-aaaaaaaa', '2026-03-06T12:05:00.000Z', {
      slug_perm: 'beta-slug',
      tags: {
        info: [
          'portico-routing-v1',
          'portico-eol-true',
          'portico-redirect-portico_dev',
          'portico-update-ready-v1',
        ],
      },
    }),
  ];
  const server = await createServer({ packages });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeUpdateChannel(projectRoot, beta);

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.match(result.error, /missing portico-force-update-true/);
    assert.equal(readUpdateChannel(projectRoot), beta);
    assert.equal(hasMetadataRequest(server), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testMultipleRedirectEolTagsDoNotPersistRedirect() {
  const beta = 'portico_beta';
  const packages = [
    buildPackage(beta, '03152026-aaaaaaaa', '2026-03-06T12:05:00.000Z', {
      slug_perm: 'beta-slug',
      tags: buildRoutingTags('portico_dev', ['portico-redirect-portico']),
    }),
  ];
  const server = await createServer({ packages });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeUpdateChannel(projectRoot, beta);

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.match(result.error, /multiple redirect targets/);
    assert.equal(readUpdateChannel(projectRoot), beta);
    assert.equal(hasMetadataRequest(server), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testSelfEolRedirectDoesNotPersistRedirect() {
  const beta = 'portico_beta';
  const packages = [
    buildPackage(beta, '03152026-aaaaaaaa', '2026-03-06T12:05:00.000Z', {
      slug_perm: 'beta-slug',
      tags: buildRoutingTags(beta),
    }),
  ];
  const server = await createServer({ packages });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeUpdateChannel(projectRoot, beta);

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.match(result.error, /redirect portico_beta to itself/);
    assert.equal(readUpdateChannel(projectRoot), beta);
    assert.equal(hasMetadataRequest(server), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testChainedEolRedirectDoesNotPersistRedirect() {
  const beta = 'portico_beta';
  const dev = 'portico_dev';
  const stable = 'portico';
  const packages = [
    buildPackage(beta, '03152026-aaaaaaaa', '2026-03-06T12:05:00.000Z', {
      slug_perm: 'beta-slug',
      tags: buildRoutingTags(dev),
    }),
    buildPackage(dev, '03162026-bbbbbbbb', '2026-03-06T12:06:00.000Z', {
      slug_perm: 'dev-slug',
      tags_immutable: buildRoutingTags(stable),
    }),
    buildPackage(stable, '03172026-cccccccc', '2026-03-06T12:07:00.000Z', { slug_perm: 'stable-slug' }),
  ];
  const server = await createServer({ packages });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeUpdateChannel(projectRoot, beta);

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.match(result.error, /chained redirects are unsupported/);
    assert.equal(readUpdateChannel(projectRoot), beta);
    assert.equal(hasMetadataRequest(server), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testMissingEolRedirectTargetDoesNotPersistRedirect() {
  const beta = 'portico_beta';
  const dev = 'portico_dev';
  const packages = [
    buildPackage(beta, '03152026-aaaaaaaa', '2026-03-06T12:05:00.000Z', {
      slug_perm: 'beta-slug',
      tags: buildRoutingTags(dev),
    }),
  ];
  const server = await createServer({ packages });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeUpdateChannel(projectRoot, beta);

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.match(result.error, /No builds are available on the "Development" release channel/);
    assert.equal(readUpdateChannel(projectRoot), beta);
    assert.equal(hasMetadataRequest(server), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testUnreadyEolRedirectTargetDoesNotPersistRedirect() {
  const beta = 'portico_beta';
  const dev = 'portico_dev';
  const packages = [
    buildPackage(beta, '03152026-aaaaaaaa', '2026-03-06T12:05:00.000Z', {
      slug_perm: 'beta-slug',
      tags: buildRoutingTags(dev),
    }),
    buildPackage(dev, '03162026-bbbbbbbb', '2026-03-06T12:06:00.000Z', {
      slug_perm: 'dev-slug',
      tags: { info: [] },
      tags_immutable: { info: [] },
    }),
  ];
  const server = await createServer({ packages });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeUpdateChannel(projectRoot, beta);
    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port,
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    // PORTICO-438: an unready redirect target now reports why it is unusable rather
    // than claiming the channel is empty. The load-bearing assertion here is the
    // one below -- the redirect must not be persisted.
    assert.match(result.error, /none carry the portico-update-ready-v1 marker/);
    assert.equal(readUpdateChannel(projectRoot), beta);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testNoRoutingTagsUsesNormalUpdateCheckWithoutMetadataRequest() {
  const beta = 'portico_beta';
  const buildId = '03152026-aaaaaaaa';
  const packages = [
    buildPackage(beta, buildId, '2026-03-06T12:05:00.000Z', { slug_perm: 'beta-slug' }),
  ];
  const server = await createServer({ packages });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeUpdateChannel(projectRoot, beta);

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(result.forceUpdate, undefined);
    assert.equal(result.latestBuildNumber, buildId);
    assert.equal(result.updateChannel, beta);
    assert.equal(readUpdateChannel(projectRoot), beta);
    assert.equal(hasMetadataRequest(server), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testCustomEolRedirectDoesNotDisplayAsStable() {
  const beta = 'portico_beta';
  const custom = 'portico_sunset';
  const packages = [
    buildPackage(beta, '03152026-aaaaaaaa', '2026-03-06T12:05:00.000Z', {
      slug_perm: 'beta-slug',
      tags: buildRoutingTags(custom),
    }),
    buildPackage(custom, '03162026-bbbbbbbb', '2026-03-06T12:06:00.000Z', { slug_perm: 'custom-slug' }),
  ];
  const server = await createServer({ packages });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeUpdateChannel(projectRoot, beta);

    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '03142026-deadbeef',
      port
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, true);
    assert.equal(result.updateChannel, custom);
    assert.equal(result.updateChannelDisplay, 'custom');
    assert.notEqual(result.updateChannelDisplay, 'stable');
    assert.equal(readUpdateChannel(projectRoot), custom);
    assert.equal(hasMetadataRequest(server), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// PORTICO-438: an unverified package and an empty channel are different problems and
// need different actions. Conflating them is what made a published mr-330 build
// report "No builds are available", sending diagnosis after timing, naming and
// repository dead ends while the build sat in Cloudsmith untagged.
async function testUnreadyOnlyChannelExplainsMissingMarker() {
  const channel = 'portico_mr-330';
  const packages = [
    buildPackage(channel, '08182026-e629b415', '2026-08-18T10:47:25.000Z', {
      tags: { info: [] },
      tags_immutable: { info: [] },
    }),
  ];
  const server = await createServer({ packages });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    writeUpdateChannel(projectRoot, channel);
    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '08172026-aaaaaaaa',
      port,
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.match(result.error, /none carry the portico-update-ready-v1 marker/);
    assert.match(result.error, /1 package\(s\)/);
    assert.match(result.error, /08182026-e629b415/);
    assert.doesNotMatch(
      result.error,
      /choose a channel that has builds/,
      'the channel is not empty, so it must not be described as empty',
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testTrulyEmptyChannelKeepsChannelSwitchGuidance() {
  const packages = [
    buildPackage('portico_beta', '08182026-aaaaaaaa', '2026-08-18T10:00:00.000Z'),
  ];
  const server = await createServer({ packages });

  try {
    const port = server.address().port;
    const homeDir = makeTempHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-cloudsmith-project-'));
    // A channel with nothing published at all, unlike the case above.
    writeUpdateChannel(projectRoot, 'portico_mr-999');
    const updates = loadUpdates({
      homeDir,
      projectRoot,
      currentBuild: '08172026-aaaaaaaa',
      port,
    });

    const result = await updates.checkForUpdates();

    assert.equal(result.updateAvailable, false);
    assert.match(result.error, /choose a channel that has builds/);
    assert.doesNotMatch(result.error, /portico-update-ready-v1 marker/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  const tests = [
    ['unready-only channel explains the missing readiness marker', testUnreadyOnlyChannelExplainsMissingMarker],
    ['a truly empty channel keeps the channel-switch guidance', testTrulyEmptyChannelKeepsChannelSwitchGuidance],
    ['uses uploaded_at for same-build republish detection', testUploadedAtSameBuildRepublish],
    ['same-day older uploads do not force downgrades', testSameDayOlderUploadDoesNotDowngrade],
    ['same-day newer uploads remain eligible', testSameDayNewerUploadIsEligible],
    ['newest unready package does not hide the prior ready release', testNewestUnreadyPackageDoesNotHidePriorReadyRelease],
    ['mutable ready tags do not produce automatic updates', testMutableReadyTagDoesNotProduceAutomaticUpdate],
    ['same-day different SHAs require a trusted local timestamp', testSameDayDifferentShaRequiresTrustedLocalTimestamp],
    ['same-day version comparison rejects missing or invalid timestamps', testSameDayVersionComparisonRejectsInvalidTimestamps],
    ['sentinel candidates are never considered newer', testSentinelCandidateIsNeverNewer],
    ['successful-install state is persisted as build-bound JSON', testInstalledStateIsBuildBoundJson],
    ['stored install timestamps outrank older build timestamps', testStoredInstallTimestampTakesPrecedenceOverOlderBuildTimestamp],
    ['exact installed package prevents 8ea-to-3409 downgrade despite legacy state', testExactInstalledPackagePreventsSameDayDowngradeWithLegacyTimestamp],
    ['modern builds ignore the sentinel and stay on the same real build', testModernBuildIgnoresSentinelAndStaysOnSameBuild],
    ['modern builds ignore the sentinel and select a newer real build', testModernBuildIgnoresSentinelAndSelectsNewerRelease],
    ['sentinel-only repositories do not offer an update', testSentinelOnlyRepositoryDoesNotOfferUpdate],
    ['bridge builds pick the newest valid rescue target', testBridgeBuildPrefersNewestValidRescueTarget],
    ['short first pages stop pagination before a later 404', testShortFirstPageStopsPaginationBefore404],
    ['404 on later pages ends pagination gracefully', testLaterPage404EndsPaginationGracefully],
    ['unexpected cdn_url falls back to canonical raw URL', testCheckForUpdatesFallsBackFromUnexpectedCdnUrl],
    ['valid raw cdn_url is preserved with entitlement token substitution', testCheckForUpdatesPreservesValidRawCdnUrl],
    ['findSpecificBuild accepts an exact legacy unready package and falls back from unexpected cdn_url', testFindSpecificBuildFallsBackFromUnexpectedCdnUrl],
    ['findSpecificBuild rejects sentinel builds without a request', testFindSpecificBuildRejectsSentinelWithoutRequest],
    ['packages without usable download URLs are skipped during selection', testCheckForUpdatesSkipsPackagesWithoutUsableDownloadUrl],
    ['dev channel uses API key for discovery and entitlement for downloads', testDevChannelUsesApiKeyForDiscoveryAndEntitlementForDownload],
    ['missing API key fails before a Cloudsmith request', testMissingApiKeyFailsBeforeCloudsmithRequest],
    ['Cloudsmith API 401 remains an update-check error', testCloudsmithApi401RemainsAnError],
    ['404 on the first page still reports an error', testFirstPage404RemainsAnError],
    ['entitlement tokens are not sent as Cloudsmith API keys', testEntitlementTokenIsNotUsedAsApiKeyForDiscovery],
    ['EOL tags redirect to target latest and persists channel', testEolRedirectsToTargetLatestAndPersistsChannel],
    ['EOL redirect forces same-build different-channel update', testEolRedirectForcesSameBuildDifferentChannel],
    ['invalid EOL tags do not persist redirect', testInvalidEolTagsDoNotPersistRedirect],
    ['missing force EOL tags do not persist redirect', testMissingForceEolTagsDoNotPersistRedirect],
    ['multiple redirect EOL tags do not persist redirect', testMultipleRedirectEolTagsDoNotPersistRedirect],
    ['self EOL redirect does not persist redirect', testSelfEolRedirectDoesNotPersistRedirect],
    ['chained EOL redirect does not persist redirect', testChainedEolRedirectDoesNotPersistRedirect],
    ['missing EOL redirect target does not persist redirect', testMissingEolRedirectTargetDoesNotPersistRedirect],
    ['unready EOL redirect target does not persist redirect', testUnreadyEolRedirectTargetDoesNotPersistRedirect],
    ['no routing tags use normal update check without metadata request', testNoRoutingTagsUsesNormalUpdateCheckWithoutMetadataRequest],
    ['custom EOL redirect does not display as stable', testCustomEolRedirectDoesNotDisplayAsStable],
  ];

  for (const [name, fn] of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
}

main().catch(error => {
  console.error(error.stack || String(error));
  process.exit(1);
});
