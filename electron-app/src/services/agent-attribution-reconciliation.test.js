const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const agentLinks = require("./ai-marketplace-agent-links");
const reconciliation = require("./agent-attribution-reconciliation");

function tempLinkDeps() {
  return {
    userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), "agent-attribution-reconcile-")),
  };
}

test.afterEach(() => reconciliation.resetForTests());

test("successful reconciliation finalizes only the pending ids returned by Subagents", async () => {
  const agentLinkDeps = tempLinkDeps();
  await agentLinks.setInstalledLink(
    "market-agent",
    "solution-1",
    "publisher",
    { ...agentLinkDeps, attributionPending: true },
  );
  const calls = [];
  const result = await reconciliation.reconcileAgentAttribution({
    agentLinkDeps,
    invokeMcpTool: async (serverId, toolName, args, port) => {
      calls.push({ serverId, toolName, args, port });
      return {
        success: true,
        data: {
          repaired_ids: ["market-agent", "chuckles"],
          finalized_pending_ids: ["market-agent"],
          failures: [],
        },
      };
    },
  });

  assert.deepEqual(result.repaired_ids, ["market-agent", "chuckles"]);
  assert.deepEqual(calls, [
    {
      serverId: "subagents",
      toolName: "subagents_reconcile_agent_attribution",
      args: {},
      port: 8766,
    },
  ]);
  assert.equal(
    (await agentLinks.getLink("market-agent", agentLinkDeps)).attributionPending,
    false,
  );
});

test("partial reconciliation stays retryable", async () => {
  let attempts = 0;
  const invokeMcpTool = async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        success: true,
        data: {
          repaired_ids: ["chuckles"],
          finalized_pending_ids: [],
          failures: [{ id: "research-pro", error: "temporary" }],
        },
      };
    }
    return {
      success: true,
      data: {
        repaired_ids: ["research-pro"],
        finalized_pending_ids: [],
        failures: [],
      },
    };
  };

  await assert.rejects(
    () => reconciliation.reconcileAgentAttribution({ invokeMcpTool }),
    (error) => error?.code === "agent_attribution_partial_failure",
  );
  const retried = await reconciliation.reconcileAgentAttribution({ invokeMcpTool });
  assert.deepEqual(retried.repaired_ids, ["research-pro"]);
  assert.equal(attempts, 2);
});

test("startup waits after the core gate and later core-capable health runs retry", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const dockerMcpSource = fs.readFileSync(
    path.join(__dirname, "docker-mcp.js"),
    "utf8",
  );
  assert.match(
    mainSource,
    /if \(startupCoreSyncResult\?\.success\) \{[\s\S]*await agentAttributionReconciliation\.reconcileAgentAttribution\([\s\S]*loading-step-complete/s,
  );
  assert.match(
    dockerMcpSource,
    /mode === "full" \|\| mode === "startup-core"[\s\S]*scheduleAgentAttributionReconciliation/s,
  );
});
