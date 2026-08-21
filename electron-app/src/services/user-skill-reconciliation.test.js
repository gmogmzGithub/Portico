const test = require("node:test");
const assert = require("node:assert/strict");

const reconciliation = require("./user-skill-reconciliation");

test.beforeEach(() => reconciliation.resetForTests());
test.afterEach(() => reconciliation.resetForTests());

test("partial failures remain retryable and retain repaired ids", async () => {
  let calls = 0;
  const reconcile = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        repaired_ids: ["healthy"],
        skipped_ids: [],
        failures: [
          { id: "malformed", code: "malformed_skill_frontmatter" },
        ],
      };
    }
    return {
      repaired_ids: ["malformed"],
      skipped_ids: ["healthy"],
      failures: [],
    };
  };

  await assert.rejects(
    () => reconciliation.reconcileUserSkills({ reconcile }),
    (error) => {
      assert.equal(error?.code, "user_skill_reconciliation_partial_failure");
      assert.deepEqual(error?.result?.repaired_ids, ["healthy"]);
      return true;
    },
  );
  const retried = await reconciliation.reconcileUserSkills({ reconcile });
  assert.deepEqual(retried.repaired_ids, ["malformed"]);
  assert.equal(calls, 2);
});

test("successful runs have no one-time marker and concurrent callers coalesce", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reconcile = async () => {
    calls += 1;
    await gate;
    return { repaired_ids: [], skipped_ids: [], failures: [] };
  };

  const first = reconciliation.reconcileUserSkills({ reconcile });
  const concurrent = reconciliation.reconcileUserSkills({ reconcile });
  release();
  await Promise.all([first, concurrent]);
  assert.equal(calls, 1);

  await reconciliation.reconcileUserSkills({
    reconcile: async () => {
      calls += 1;
      return { repaired_ids: [], skipped_ids: [], failures: [] };
    },
  });
  assert.equal(calls, 2);
});
