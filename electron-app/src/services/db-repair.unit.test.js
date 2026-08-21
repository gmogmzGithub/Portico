const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const dbRepairPath = path.join(repoRoot, 'electron-app', 'src', 'services', 'db-repair.js');

function execPromise(command, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.exec(
      command,
      {
        ...options,
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function sqlite(dbPath, sql) {
  return childProcess.execFileSync('sqlite3', [dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

function sqliteJson(dbPath, sql) {
  const output = childProcess.execFileSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(output || '[]');
}

function loadDbRepairWithMocks(projectRoot = repoRoot) {
  const originalLoad = Module._load;
  const previousModule = require.cache[dbRepairPath];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        BrowserWindow: {
          getAllWindows: () => [],
        },
      };
    }

    if (parent?.filename === dbRepairPath && request === './bootstrap') {
      return {
        PROJECT_ROOT: projectRoot,
        execPromise,
      };
    }

    if (parent?.filename === dbRepairPath && request === './shared-state') {
      return { windows: {} };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[dbRepairPath];
  const dbRepair = require(dbRepairPath);

  return {
    dbRepair,
    restore() {
      Module._load = originalLoad;
      delete require.cache[dbRepairPath];
      if (previousModule) {
        require.cache[dbRepairPath] = previousModule;
      }
    },
  };
}

test('sanitizeInvalidChatRows preserves bad payloads and writes per-chat placeholders', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owui-db-repair-test-'));
  const dbPath = path.join(tempDir, 'webui.db');
  const loader = loadDbRepairWithMocks();

  try {
    sqlite(
      dbPath,
      `
CREATE TABLE chat (
  id TEXT PRIMARY KEY,
  title TEXT,
  chat TEXT,
  meta TEXT
);
INSERT INTO chat (id, title, chat, meta)
VALUES
  ('good-chat', 'Good Chat', '{"id":"good-chat","history":{"messages":{},"currentId":null}}', '{}'),
  ('bad-chat', 'Bad Chat', '{not json', '');
`,
    );

    const result = await loader.dbRepair.sanitizeInvalidChatRows(dbPath);
    assert.equal(result.fixedRows, 1);
    assert.equal(result.fixedMetaRows, 1);
    assert.equal(result.skipped, false);

    const rows = sqliteJson(
      dbPath,
      `
SELECT
  id,
  json_extract(chat, '$.id') AS payload_id,
  json_extract(chat, '$.title') AS payload_title,
  json_extract(chat, '$.recovered_from_corruption') AS recovered,
  json_type(chat, '$.history.messages') AS messages_type,
  json_type(chat, '$.messages') AS flat_messages_type,
  meta
FROM chat
ORDER BY id;
`,
    );

    const bad = rows.find((row) => row.id === 'bad-chat');
    const good = rows.find((row) => row.id === 'good-chat');
    assert.deepEqual(
      {
        payload_id: bad.payload_id,
        payload_title: bad.payload_title,
        recovered: bad.recovered,
        messages_type: bad.messages_type,
        flat_messages_type: bad.flat_messages_type,
        meta: bad.meta,
      },
      {
        payload_id: 'bad-chat',
        payload_title: 'Bad Chat',
        recovered: 1,
        messages_type: 'object',
        flat_messages_type: 'array',
        meta: '{}',
      },
    );
    assert.equal(good.payload_id, 'good-chat');
    assert.equal(good.recovered, null);
    assert.equal(good.meta, '{}');

    const backups = sqliteJson(
      dbPath,
      "SELECT id, title, raw_chat FROM _chat_corrupt_backup;",
    );
    assert.deepEqual(backups, [
      {
        id: 'bad-chat',
        title: 'Bad Chat',
        raw_chat: '{not json',
      },
    ]);

    const metaBackups = sqliteJson(
      dbPath,
      "SELECT id, title, raw_meta FROM _chat_corrupt_meta_backup;",
    );
    assert.deepEqual(metaBackups, [
      {
        id: 'bad-chat',
        title: 'Bad Chat',
        raw_meta: '',
      },
    ]);
  } finally {
    loader.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('repair flow sanitizes recovered chat rows before accepting recovered database', async () => {
  const source = await fs.readFile(dbRepairPath, 'utf8');
  assert.match(
    source,
    /const sanitizeResult = await sanitizeInvalidChatRows\(recoveredDbPath\);[\s\S]*const postIntegrity = await checkIntegrity\(recoveredDbPath\);/s,
    'recovered databases should sanitize invalid chat JSON before the final integrity gate',
  );
});

// ---------------------------------------------------------------------------
// PORTICO-201: SQLite disk I/O error detection + restart-only repair
// ---------------------------------------------------------------------------

test('buildCorruptionSummary detects qualified sqlite disk I/O error lines', () => {
  const loader = loadDbRepairWithMocks();
  try {
    const logText = [
      '2026-07-06T17:20:33Z ERROR open_webui.models.functions:get_function_valves_by_id - error',
      'sqlalchemy.exc.OperationalError: (sqlite3.OperationalError) disk I/O error [SQL: SELECT function.id AS function_id FROM function WHERE function.type = ?] [parameters: (\'filter\',)]',
    ].join('\n');

    const summary = loader.dbRepair.buildCorruptionSummary(logText);
    assert.equal(summary.detected, true);
    assert.equal(summary.matches.length, 1);
    assert.ok(summary.signature);
  } finally {
    loader.restore();
  }
});

test('buildCorruptionSummary detects bare DBAPI-form disk I/O error lines', () => {
  const loader = loadDbRepairWithMocks();
  try {
    const summary = loader.dbRepair.buildCorruptionSummary(
      'sqlite3.OperationalError: disk I/O error',
    );
    assert.equal(summary.detected, true);
  } finally {
    loader.restore();
  }
});

test('buildCorruptionSummary redacts SQL statements and parameters from matches', () => {
  const loader = loadDbRepairWithMocks();
  try {
    const summary = loader.dbRepair.buildCorruptionSummary(
      "sqlalchemy.exc.OperationalError: (sqlite3.OperationalError) disk I/O error [SQL: INSERT INTO chat (title) VALUES (?)] [parameters: ('secret user text',)]",
    );
    assert.equal(summary.detected, true);
    assert.equal(summary.matches.length, 1);
    assert.ok(!summary.matches[0].includes('[SQL'));
    assert.ok(!summary.matches[0].includes('secret user text'));
    assert.ok(summary.matches[0].includes('disk I/O error'));
  } finally {
    loader.restore();
  }
});

test('buildCorruptionSummary ignores unqualified disk I/O prose', () => {
  const loader = loadDbRepairWithMocks();
  try {
    const logText = [
      'INFO user message: I keep hitting a disk I/O error on my NAS, any ideas?',
      'INFO [TOOL-CALL] result mentions disk i/o error in prose',
      'INFO normal request completed in 12ms',
    ].join('\n');

    const summary = loader.dbRepair.buildCorruptionSummary(logText);
    assert.equal(summary.detected, false);
    assert.deepEqual(summary.matches, []);
  } finally {
    loader.restore();
  }
});

test('buildCorruptionSummary still detects malformed database signatures', () => {
  const loader = loadDbRepairWithMocks();
  try {
    const summary = loader.dbRepair.buildCorruptionSummary(
      'sqlalchemy.exc.DatabaseError: (sqlite3.DatabaseError) database disk image is malformed',
    );
    assert.equal(summary.detected, true);
  } finally {
    loader.restore();
  }
});

test('repair skips database rewrite when quick_check passes (restart-only)', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owui-db-restart-only-'));
  const dataDir = path.join(tempDir, 'open-webui-data');
  await fs.mkdir(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'webui.db');
  const loader = loadDbRepairWithMocks(tempDir);

  try {
    sqlite(
      dbPath,
      `
CREATE TABLE chat (id TEXT PRIMARY KEY, title TEXT, chat TEXT, meta TEXT);
INSERT INTO chat (id, title, chat, meta)
VALUES ('healthy-chat', 'Healthy Chat', '{"id":"healthy-chat"}', '{}');
`,
    );
    const originalBytes = await fs.readFile(dbPath);

    const result = await loader.dbRepair.repairOpenWebuiDb({
      dbPath,
      manageContainer: false,
    });

    assert.equal(result.success, true);
    assert.equal(result.repairMode, 'integrity-ok-restart-only');
    assert.equal(result.preIntegrity.ok, true);
    assert.ok(
      result.notes.some((note) => note.includes('restart-only')),
      'restart-only note should be recorded',
    );

    // The live database file must be untouched (no .recover rewrite/swap).
    const afterBytes = await fs.readFile(dbPath);
    assert.ok(originalBytes.equals(afterBytes));

    // A safety backup is still taken before anything else.
    assert.ok(result.backup.db);
    const backupBytes = await fs.readFile(result.backup.db);
    assert.ok(originalBytes.equals(backupBytes));

    const rows = sqliteJson(dbPath, 'SELECT id, title FROM chat;');
    assert.deepEqual(rows, [{ id: 'healthy-chat', title: 'Healthy Chat' }]);
  } finally {
    loader.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
