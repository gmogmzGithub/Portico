const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function readRepoFile(...segments) {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8');
}

test('clean_full script matches dev Electron launch shapes and fails closed if Electron survives', () => {
  const cleanFullSource = readRepoFile('clean_full.sh');

  assert.equal(
    cleanFullSource.includes('*"$SCRIPT_DIR"/electron-app/node_modules/.bin/electron'),
    true,
    'cleanup should match the npm-start electron wrapper that launches the dev app from electron-app/',
  );
  assert.equal(
    cleanFullSource.includes('*"$SCRIPT_DIR"/electron-app/node_modules/electron/*'),
    true,
    'cleanup should match the actual Electron binary and helper processes under electron-app/node_modules/electron/',
  );
  assert.equal(
    cleanFullSource.includes('*"--user-data-dir=$ELECTRON_APP_SUPPORT"*)'),
    true,
    'cleanup should match Electron helper processes by the app user-data directory so helper subprocesses are not left behind',
  );
  assert.equal(
    cleanFullSource.includes('FINAL_REMAINING_APP_PIDS=()'),
    true,
    'cleanup should re-check for surviving Electron processes after TERM and KILL before claiming success',
  );
  assert.equal(
    cleanFullSource.includes('if ! $DRY_RUN; then'),
    true,
    'the fail-closed survivor check should only run during a real cleanup, not during a dry-run preview',
  );
  assert.equal(
    cleanFullSource.includes('fail "Electron app is still running after cleanup'),
    true,
    'cleanup should fail closed instead of reporting success when matched Electron processes survive',
  );
});

test('clean_full permanently excludes the protected repository dotenv from cleanup', () => {
  const cleanFullSource = readRepoFile('clean_full.sh');
  assert.match(cleanFullSource, /GIT_CLEAN_PATHS=\(-- \. ':\(exclude,top\)\.env'\)/);
  assert.match(cleanFullSource, /Repository \.env is protected and will be preserved/);

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-full-env-'));
  try {
    fs.writeFileSync(path.join(fixture, '.gitignore'), '.env\ncache/\n');
    fs.writeFileSync(
      path.join(fixture, '.env'),
      'CLOUDSMITH_API_KEY=protected-test-key\n',
      { mode: 0o600 },
    );
    fs.mkdirSync(path.join(fixture, 'cache'));
    fs.writeFileSync(path.join(fixture, 'cache', 'artifact'), 'ignored\n');

    const init = spawnSync('git', ['init', '-q'], {
      cwd: fixture,
      encoding: 'utf8',
    });
    assert.equal(init.status, 0, `${init.stdout}\n${init.stderr}`);
    const clean = spawnSync(
      'git',
      ['clean', '-fdX', '--', '.', ':(exclude,top).env'],
      { cwd: fixture, encoding: 'utf8' },
    );
    assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);
    assert.equal(
      fs.readFileSync(path.join(fixture, '.env'), 'utf8'),
      'CLOUDSMITH_API_KEY=protected-test-key\n',
    );
    assert.equal(fs.existsSync(path.join(fixture, 'cache')), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
