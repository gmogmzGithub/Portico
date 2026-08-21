const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  cleanupStartupAgentVms,
  deriveVmIdFromContainerName,
  getRecoveryWorkspacePath,
} = require("./agent-vm-startup-cleanup");
const MAIN_SOURCE = fs.readFileSync(
  path.join(__dirname, "main.js"),
  "utf8",
);

function createWorkspaceRoot(prefix = "agent-vm-startup-cleanup-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRecoveryMarker(workspaceRoot, chatId, vmId, relativePath = "output/report.txt") {
  const markerPath = path.join(workspaceRoot, chatId, "agents", vmId, relativePath);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, "preserve me", "utf8");
  return markerPath;
}

function makeRunCommand(routes) {
  return async (command) => {
    for (const route of routes) {
      if (route.match.test(command)) {
        if (route.error) {
          throw route.error;
        }
        return route.stdout ?? "";
      }
    }
    throw new Error(`Unexpected command: ${command}`);
  };
}

test("deriveVmIdFromContainerName extracts VM ids safely", () => {
  assert.equal(deriveVmIdFromContainerName("agent-vm-123"), "123");
  assert.equal(deriveVmIdFromContainerName("/agent-vm-xyz"), "xyz");
  assert.equal(deriveVmIdFromContainerName("agent-vm-artifact-preview-123"), null);
  assert.equal(deriveVmIdFromContainerName("/agent-vm-artifact-helper-123"), null);
  assert.equal(deriveVmIdFromContainerName("mcpo"), null);
});

test("getRecoveryWorkspacePath builds workspace recovery paths", () => {
  assert.equal(
    getRecoveryWorkspacePath("workspaces", "chat-1", "vm-1"),
    path.join("workspaces", "chat-1", "agents", "vm-1"),
  );
  assert.equal(getRecoveryWorkspacePath("workspaces", "", "vm-1"), null);
});

test("cleanupStartupAgentVms preserves active Agent VMs and workspace files", async () => {
  const workspaceRoot = createWorkspaceRoot();
  const markerPath = writeRecoveryMarker(workspaceRoot, "chat-1", "vm-1");
  const nowSeconds = 1_000;
  const calls = [];
  const runCommand = makeRunCommand([
    {
      match: /docker ps -a --filter "name=agent-vm-" --format "\{\{\.Names\}\}"/,
      stdout: "agent-vm-vm-1\n",
    },
    {
      match: /docker inspect --format '\{\{\.State\.Status\}\}' 'agent-vm-vm-1'/,
      stdout: "running\n",
    },
    {
      match: /redis-cli --raw GET 'agent_vm_info:vm-1'/,
      stdout: JSON.stringify({
        vm_id: "vm-1",
        chat_id: "chat-1",
        last_activity: nowSeconds - 30,
        timeout_hours: 1,
      }),
    },
    {
      match: /redis-cli PERSIST 'agent_vm_info:vm-1'/,
      stdout: "1\n",
    },
    {
      match: /redis-cli --raw GET 'agent_vm:chat-1'/,
      stdout: "vm-1\n",
    },
    {
      match: /redis-cli PERSIST 'agent_vm:chat-1'/,
      stdout: "1\n",
    },
  ]);
  const report = await cleanupStartupAgentVms({
    workspaceRoot,
    nowSeconds,
    runCommand: async (command) => {
      calls.push(command);
      return runCommand(command);
    },
  });

  assert.equal(report.inspectedCount, 1);
  assert.equal(report.keptCount, 1);
  assert.equal(report.removedCount, 0);
  assert.equal(report.warnings.length, 0);
  assert.ok(calls.some((command) => command.includes("PERSIST 'agent_vm_info:vm-1'")));
  assert.ok(calls.some((command) => command.includes("PERSIST 'agent_vm:chat-1'")));
  assert.equal(report.kept[0].recoveryPath, path.join(workspaceRoot, "chat-1", "agents", "vm-1"));
  assert.equal(fs.existsSync(markerPath), true);

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test("cleanupStartupAgentVms ignores artifact runtime containers", async () => {
  const workspaceRoot = createWorkspaceRoot();
  const calls = [];
  const report = await cleanupStartupAgentVms({
    workspaceRoot,
    nowSeconds: 1_000,
    runCommand: async (command) => {
      calls.push(command);
      if (/docker ps -a --filter "name=agent-vm-"/.test(command)) {
        return "agent-vm-artifact-preview-123\nagent-vm-artifact-helper-123\n";
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  });

  assert.equal(report.inspectedCount, 0);
  assert.equal(report.keptCount, 0);
  assert.equal(report.removedCount, 0);
  assert.equal(calls.length, 1);

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test("cleanupStartupAgentVms removes orphaned Agent VMs but preserves workspace files", async () => {
  const workspaceRoot = createWorkspaceRoot();
  const markerPath = writeRecoveryMarker(workspaceRoot, "chat-1", "orphaned");
  const report = await cleanupStartupAgentVms({
    workspaceRoot,
    nowSeconds: 1_000,
    runCommand: makeRunCommand([
      {
        match: /docker ps -a --filter "name=agent-vm-" --format "\{\{\.Names\}\}"/,
        stdout: "agent-vm-orphaned\n",
      },
      {
        match: /docker inspect --format '\{\{\.State\.Status\}\}' 'agent-vm-orphaned'/,
        stdout: "running\n",
      },
      {
        match: /redis-cli --raw GET 'agent_vm_info:orphaned'/,
        stdout: "",
      },
      {
        match: /docker rm -f 'agent-vm-orphaned'/,
        stdout: "agent-vm-orphaned\n",
      },
      {
        match: /redis-cli DEL 'agent_vm_info:orphaned'/,
        stdout: "0\n",
      },
      {
        match: /redis-cli DEL 'agent_vm_file_reads:orphaned'/,
        stdout: "0\n",
      },
      {
        match: /redis-cli --raw --scan --pattern 'agent_vm:\*'/,
        stdout: "agent_vm:chat-1\nagent_vm:chat-2\n",
      },
      {
        match: /redis-cli --raw GET 'agent_vm:chat-1'/,
        stdout: "orphaned\n",
      },
      {
        match: /redis-cli DEL 'agent_vm:chat-1'/,
        stdout: "1\n",
      },
      {
        match: /redis-cli --raw GET 'agent_vm:chat-2'/,
        stdout: "someone-else\n",
      },
    ]),
  });

  assert.equal(report.keptCount, 0);
  assert.equal(report.removedCount, 1);
  assert.equal(report.removed[0].reason, "missing_metadata");
  assert.deepEqual(report.removed[0].deletedMappings, ["agent_vm:chat-1"]);
  assert.equal(report.removed[0].recoveryPath, path.join(workspaceRoot, "chat-1", "agents", "orphaned"));
  assert.equal(report.removed[0].workspacePreserved, true);
  assert.equal(fs.existsSync(markerPath), true);

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test("cleanupStartupAgentVms removes expired Agent VMs but preserves workspace files", async () => {
  const workspaceRoot = createWorkspaceRoot();
  const markerPath = writeRecoveryMarker(workspaceRoot, "chat-2", "expired");
  const nowSeconds = 10_000;
  const report = await cleanupStartupAgentVms({
    workspaceRoot,
    nowSeconds,
    runCommand: makeRunCommand([
      {
        match: /docker ps -a --filter "name=agent-vm-" --format "\{\{\.Names\}\}"/,
        stdout: "agent-vm-expired\n",
      },
      {
        match: /docker inspect --format '\{\{\.State\.Status\}\}' 'agent-vm-expired'/,
        stdout: "running\n",
      },
      {
        match: /redis-cli --raw GET 'agent_vm_info:expired'/,
        stdout: JSON.stringify({
          vm_id: "expired",
          chat_id: "chat-2",
          last_activity: nowSeconds - 7200,
          timeout_hours: 1,
        }),
      },
      {
        match: /docker rm -f 'agent-vm-expired'/,
        stdout: "agent-vm-expired\n",
      },
      {
        match: /redis-cli DEL 'agent_vm_info:expired'/,
        stdout: "1\n",
      },
      {
        match: /redis-cli DEL 'agent_vm_file_reads:expired'/,
        stdout: "1\n",
      },
      {
        match: /redis-cli --raw GET 'agent_vm:chat-2'/,
        stdout: "expired\n",
      },
      {
        match: /redis-cli DEL 'agent_vm:chat-2'/,
        stdout: "1\n",
      },
    ]),
  });

  assert.equal(report.removedCount, 1);
  assert.equal(report.removed[0].reason, "expired");
  assert.equal(report.removed[0].recoveryPath, path.join(workspaceRoot, "chat-2", "agents", "expired"));
  assert.equal(fs.existsSync(markerPath), true);

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test("cleanupStartupAgentVms removes stopped Agent VMs but preserves workspace files", async () => {
  const workspaceRoot = createWorkspaceRoot();
  const markerPath = writeRecoveryMarker(workspaceRoot, "chat-3", "stopped");
  const nowSeconds = 2_000;
  const report = await cleanupStartupAgentVms({
    workspaceRoot,
    nowSeconds,
    runCommand: makeRunCommand([
      {
        match: /docker ps -a --filter "name=agent-vm-" --format "\{\{\.Names\}\}"/,
        stdout: "agent-vm-stopped\n",
      },
      {
        match: /docker inspect --format '\{\{\.State\.Status\}\}' 'agent-vm-stopped'/,
        stdout: "exited\n",
      },
      {
        match: /redis-cli --raw GET 'agent_vm_info:stopped'/,
        stdout: JSON.stringify({
          vm_id: "stopped",
          chat_id: "chat-3",
          last_activity: nowSeconds - 5,
          timeout_hours: 1,
        }),
      },
      {
        match: /docker rm -f 'agent-vm-stopped'/,
        stdout: "agent-vm-stopped\n",
      },
      {
        match: /redis-cli DEL 'agent_vm_info:stopped'/,
        stdout: "1\n",
      },
      {
        match: /redis-cli DEL 'agent_vm_file_reads:stopped'/,
        stdout: "1\n",
      },
      {
        match: /redis-cli --raw GET 'agent_vm:chat-3'/,
        stdout: "stopped\n",
      },
      {
        match: /redis-cli DEL 'agent_vm:chat-3'/,
        stdout: "1\n",
      },
    ]),
  });

  assert.equal(report.removedCount, 1);
  assert.equal(report.removed[0].reason, "container_state");
  assert.equal(report.removed[0].status, "exited");
  assert.equal(fs.existsSync(markerPath), true);

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test("cleanupStartupAgentVms removes invalid metadata but preserves workspace files", async () => {
  const workspaceRoot = createWorkspaceRoot();
  const markerPath = writeRecoveryMarker(workspaceRoot, "chat-7", "invalid");
  const report = await cleanupStartupAgentVms({
    workspaceRoot,
    nowSeconds: 3_000,
    runCommand: makeRunCommand([
      {
        match: /docker ps -a --filter "name=agent-vm-" --format "\{\{\.Names\}\}"/,
        stdout: "agent-vm-invalid\n",
      },
      {
        match: /docker inspect --format '\{\{\.State\.Status\}\}' 'agent-vm-invalid'/,
        stdout: "running\n",
      },
      {
        match: /redis-cli --raw GET 'agent_vm_info:invalid'/,
        stdout: "{not-json}\n",
      },
      {
        match: /docker rm -f 'agent-vm-invalid'/,
        stdout: "agent-vm-invalid\n",
      },
      {
        match: /redis-cli DEL 'agent_vm_info:invalid'/,
        stdout: "1\n",
      },
      {
        match: /redis-cli DEL 'agent_vm_file_reads:invalid'/,
        stdout: "1\n",
      },
      {
        match: /redis-cli --raw --scan --pattern 'agent_vm:\*'/,
        stdout: "agent_vm:chat-7\n",
      },
      {
        match: /redis-cli --raw GET 'agent_vm:chat-7'/,
        stdout: "invalid\n",
      },
      {
        match: /redis-cli DEL 'agent_vm:chat-7'/,
        stdout: "1\n",
      },
    ]),
  });

  assert.equal(report.removedCount, 1);
  assert.equal(report.removed[0].reason, "invalid_metadata");
  assert.equal(report.removed[0].recoveryPath, path.join(workspaceRoot, "chat-7", "agents", "invalid"));
  assert.equal(fs.existsSync(markerPath), true);

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test("cleanupStartupAgentVms preserves containers when Redis metadata lookup fails", async () => {
  const workspaceRoot = createWorkspaceRoot();
  const markerPath = writeRecoveryMarker(workspaceRoot, "chat-9", "lookup-failed");
  const report = await cleanupStartupAgentVms({
    workspaceRoot,
    nowSeconds: 4_000,
    runCommand: makeRunCommand([
      {
        match: /docker ps -a --filter "name=agent-vm-" --format "\{\{\.Names\}\}"/,
        stdout: "agent-vm-lookup-failed\n",
      },
      {
        match: /docker inspect --format '\{\{\.State\.Status\}\}' 'agent-vm-lookup-failed'/,
        stdout: "running\n",
      },
      {
        match: /redis-cli --raw GET 'agent_vm_info:lookup-failed'/,
        error: new Error("redis unavailable"),
      },
    ]),
  });

  assert.equal(report.removedCount, 0);
  assert.equal(report.keptCount, 1);
  assert.match(report.warnings[0], /failed to read Redis metadata/);
  assert.equal(fs.existsSync(markerPath), true);

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test("main initialization uses metadata-aware Agent VM cleanup instead of a blanket purge", () => {
  assert.match(MAIN_SOURCE, /cleanupStartupAgentVms\(\{/);
  assert.doesNotMatch(
    MAIN_SOURCE,
    /docker ps -a --filter "name=agent-vm-" -q \| xargs -r docker rm -f/,
  );
});
