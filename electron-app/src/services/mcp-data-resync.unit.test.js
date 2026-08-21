const test = require("node:test");
const assert = require("node:assert/strict");

const {
  purgeServerDataVolume,
  resyncableServerData,
} = require("./mcp-data-resync");

function makeFakes({
  volumeList = "portico_slack-mcp-cache\n",
  volumeRmFailures = 0,
} = {}) {
  const commands = [];
  let remainingRmFailures = volumeRmFailures;
  const execAsync = async (command) => {
    commands.push(command);
    if (command.startsWith("docker volume ls")) {
      return { stdout: volumeList, stderr: "" };
    }
    if (command.startsWith("docker volume rm") && remainingRmFailures > 0) {
      remainingRmFailures -= 1;
      const error = new Error("volume is in use");
      error.code = 1;
      throw error;
    }
    return { stdout: "", stderr: "" };
  };

  const leaseEvents = [];
  const operationManager = {
    acquireMutationLease(details) {
      leaseEvents.push({ event: "acquire", details });
      return () => {
        leaseEvents.push({ event: "release" });
        return true;
      };
    },
  };

  const getRuntimeTarget = (serverId) => ({
    serverId,
    containerName: `mcpo-${serverId}`,
  });

  const logs = [];
  const logger = { log: (line) => logs.push(line), error: () => {} };

  return { commands, execAsync, operationManager, getRuntimeTarget, leaseEvents, logs, logger };
}

test("resyncableServerData exposes slack and nothing else", () => {
  assert.ok(resyncableServerData("slack"));
  assert.equal(resyncableServerData("slack").volumeKey, "slack-mcp-cache");
  assert.equal(resyncableServerData("gitlab-mcp"), null);
  assert.equal(resyncableServerData(""), null);
});

test("purge removes the container before the volume and reports success", async () => {
  const fakes = makeFakes();
  const result = await purgeServerDataVolume("slack", fakes);

  assert.equal(result.success, true);
  assert.equal(result.containerName, "mcpo-slack");
  assert.equal(result.volumeName, "portico_slack-mcp-cache");
  assert.equal(result.volumeRemoved, true);
  assert.equal(result.clearedInPlace, false);

  const rmContainerIndex = fakes.commands.findIndex((cmd) =>
    cmd.startsWith("docker rm -f mcpo-slack"),
  );
  const volumeRmIndex = fakes.commands.findIndex((cmd) =>
    cmd.startsWith("docker volume rm"),
  );
  assert.ok(rmContainerIndex >= 0 && volumeRmIndex >= 0);
  assert.ok(
    rmContainerIndex < volumeRmIndex,
    "container removal must precede volume removal (container holds the only reference)",
  );
});

test("purge resolves the volume name from compose labels", async () => {
  const fakes = makeFakes({ volumeList: "custom-project_slack-mcp-cache\n" });
  const result = await purgeServerDataVolume("slack", fakes);
  assert.equal(result.volumeName, "custom-project_slack-mcp-cache");
});

test("purge falls back to the conventional name when label lookup is empty", async () => {
  const fakes = makeFakes({ volumeList: "\n" });
  const result = await purgeServerDataVolume("slack", fakes);
  assert.equal(result.volumeName, "portico_slack-mcp-cache");
});

test("purge retries removal once and then clears contents in place", async () => {
  const fakes = makeFakes({ volumeRmFailures: 2 });
  const result = await purgeServerDataVolume("slack", fakes);

  assert.equal(result.success, true);
  assert.equal(result.volumeRemoved, false);
  assert.equal(result.clearedInPlace, true);

  const rmContainerCalls = fakes.commands.filter((cmd) =>
    cmd.startsWith("docker rm -f mcpo-slack"),
  );
  assert.equal(rmContainerCalls.length, 2, "second rm precedes the retry");
  const clearCall = fakes.commands.find((cmd) => cmd.startsWith("docker run"));
  assert.ok(clearCall.includes("portico-mcp-orc-rust:latest"));
  assert.ok(clearCall.includes("find /purge -mindepth 1 -delete"));
});

test("purge removes host sync-state files alongside the volume", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const appSupport = fs.mkdtempSync(path.join(os.tmpdir(), "resync-state-"));
  const stateDir = path.join(appSupport, "slack-mcp-state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "abc_sync_state.json"), "{}");
  fs.writeFileSync(path.join(stateDir, "abc_warmup_history.json"), "{}");
  fs.writeFileSync(path.join(stateDir, "unrelated.txt"), "keep me");

  const fakes = makeFakes();
  const result = await purgeServerDataVolume("slack", {
    ...fakes,
    appSupportHostDir: appSupport,
  });

  assert.equal(result.stateFilesRemoved, 2, "stamps and sidecars purged");
  assert.equal(
    fs.existsSync(path.join(stateDir, "abc_sync_state.json")),
    false,
    "re-sync means 'pretend first boot' - stale stamps must not survive",
  );
  assert.equal(
    fs.existsSync(path.join(stateDir, "unrelated.txt")),
    true,
    "only sync-state file families are purged",
  );
  assert.equal(
    fs.existsSync(stateDir),
    true,
    "the mounted dir itself must survive (bind mount stays valid)",
  );
});

test("purge tolerates a missing host state dir", async () => {
  const fakes = makeFakes();
  const result = await purgeServerDataVolume("slack", {
    ...fakes,
    appSupportHostDir: "/nonexistent/app-support",
  });
  assert.equal(result.success, true);
  assert.equal(result.stateFilesRemoved, 0);
});

test("purge acquires and releases the mutation lease around the docker work", async () => {
  const fakes = makeFakes();
  await purgeServerDataVolume("slack", fakes);

  assert.equal(fakes.leaseEvents[0].event, "acquire");
  assert.equal(fakes.leaseEvents[0].details.kind, "resync_server_data");
  assert.equal(fakes.leaseEvents.at(-1).event, "release");
});

test("purge releases the lease when docker commands fail", async () => {
  const fakes = makeFakes();
  fakes.execAsync = async () => {
    throw new Error("docker daemon unreachable");
  };
  await assert.rejects(() => purgeServerDataVolume("slack", fakes), {
    message: "docker daemon unreachable",
  });
  assert.equal(fakes.leaseEvents.at(-1).event, "release");
});

test("busy lease propagates MCP_OPERATION_BUSY without any docker calls", async () => {
  const fakes = makeFakes();
  fakes.operationManager = {
    acquireMutationLease() {
      const error = new Error("Another MCP change is still running");
      error.code = "MCP_OPERATION_BUSY";
      throw error;
    },
  };
  await assert.rejects(() => purgeServerDataVolume("slack", fakes), {
    code: "MCP_OPERATION_BUSY",
  });
  assert.equal(fakes.commands.length, 0, "no docker mutation while busy");
});

test("unsupported servers are rejected before taking the lease", async () => {
  const fakes = makeFakes();
  await assert.rejects(() => purgeServerDataVolume("gitlab-mcp", fakes), {
    code: "MCP_RESYNC_UNSUPPORTED",
  });
  assert.equal(fakes.leaseEvents.length, 0);
  assert.equal(fakes.commands.length, 0);
});
