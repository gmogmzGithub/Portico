const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  normalizeLinkedAgentIds,
  quoteSqlString,
  repairMarketplaceLinkedAgentAccess,
  summarizeAccessControl,
} = require("./ai-marketplace-agent-access-repair");

async function makeTempDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-access-repair-"));
  const dbPath = path.join(dir, "webui.db");
  await fs.writeFile(dbPath, "");
  return dbPath;
}

function sqlite(dbPath, sql) {
  return childProcess.execFileSync("sqlite3", [dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

function sqliteJson(dbPath, sql) {
  const output = childProcess.execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return output.trim() ? JSON.parse(output) : [];
}

test("repairMarketplaceLinkedAgentAccess clears ACL only for linked local agents", async () => {
  const dbPath = await makeTempDb();
  const sqlCalls = [];
  const logs = [];
  const logger = {
    log: (...args) => logs.push(args),
    warn: (...args) => logs.push(args),
  };

  const result = await repairMarketplaceLinkedAgentAccess({
    dbPath,
    logger,
    listLinks: async () => ({
      "chief-of-staff-agent": { solutionId: "sol-agent" },
      "team-agent": { solutionId: "sol-team" },
    }),
    runSqliteJson: async (_dbPath, sql) => {
      sqlCalls.push(sql);
      assert.match(sql, /chief-of-staff-agent/);
      assert.match(sql, /team-agent/);
      return [
        {
          id: "chief-of-staff-agent",
          access_control:
            '{"read":{"group_ids":[],"user_ids":[]},"write":{"group_ids":[],"user_ids":[]}}',
        },
      ];
    },
    runSqlite: async (_dbPath, sql) => {
      sqlCalls.push(sql);
      assert.match(sql, /UPDATE model SET access_control = NULL/);
      assert.match(sql, /chief-of-staff-agent/);
      assert.doesNotMatch(sql, /team-agent/);
    },
  });

  assert.equal(result.checked, 2);
  assert.equal(result.repaired, 1);
  assert.deepEqual(result.repairedAgentIds, ["chief-of-staff-agent"]);
  assert.equal(sqlCalls.length, 2);
  assert.equal(logs.some((entry) => entry[0].includes("repaired")), true);
});

test("repairMarketplaceLinkedAgentAccess repairs the stale OWUI ACL row in SQLite", async () => {
  const dbPath = await makeTempDb();
  const staleAcl =
    '{"read":{"group_ids":[],"user_ids":[]},"write":{"group_ids":[],"user_ids":[]}}';
  sqlite(
    dbPath,
    `
      CREATE TABLE model (id TEXT PRIMARY KEY, access_control TEXT);
      INSERT INTO model (id, access_control) VALUES ('chief-of-staff-agent', '${staleAcl}');
      INSERT INTO model (id, access_control) VALUES ('unlinked-agent', '${staleAcl}');
      INSERT INTO model (id, access_control) VALUES ('already-open-agent', NULL);
    `,
  );

  const result = await repairMarketplaceLinkedAgentAccess({
    dbPath,
    logger: { log() {}, warn() {} },
    listLinks: async () => ({
      "chief-of-staff-agent": { solutionId: "chief-solution" },
      "already-open-agent": { solutionId: "open-solution" },
    }),
  });

  assert.deepEqual(result.repairedAgentIds, ["chief-of-staff-agent"]);
  const rows = sqliteJson(
    dbPath,
    "SELECT id, access_control FROM model ORDER BY id;",
  );
  assert.deepEqual(rows, [
    { id: "already-open-agent", access_control: null },
    { id: "chief-of-staff-agent", access_control: null },
    { id: "unlinked-agent", access_control: staleAcl },
  ]);
});

test("repairMarketplaceLinkedAgentAccess skips when no marketplace links exist", async () => {
  const dbPath = await makeTempDb();
  let queried = false;
  const result = await repairMarketplaceLinkedAgentAccess({
    dbPath,
    logger: { log() {}, warn() {} },
    listLinks: async () => ({}),
    runSqliteJson: async () => {
      queried = true;
      return [];
    },
  });

  assert.equal(result.checked, 0);
  assert.equal(result.repaired, 0);
  assert.equal(queried, false);
});

test("repair helpers normalize ids and summarize ACLs", () => {
  assert.deepEqual(normalizeLinkedAgentIds({ b: {}, "": {}, a: {} }), ["a", "b"]);
  assert.equal(quoteSqlString("agent's id"), "'agent''s id'");
  assert.equal(
    summarizeAccessControl(
      '{"read":{"group_ids":[],"user_ids":[]},"write":{"group_ids":["g"],"user_ids":[]}}',
    ),
    "read:u0:g0;write:u0:g1",
  );
});
