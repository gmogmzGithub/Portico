const test = require("node:test");
const assert = require("node:assert/strict");

const {
  agentVmImage,
  reconcileChatAgentVmWorkspaceBinds,
  rebindChatAgentVms,
  validateWorkspaceBind,
  vmNeedsWorkspaceRebind,
} = require("./agent-vm-workspace-rebind");

test("agentVmImage binds packaged workspace operations to the exact release image", () => {
  assert.equal(
    agentVmImage({}, { buildNumber: "06212026-1b09617f" }),
    "harbor.example.invalid/portico/agent-vm:06212026-1b09617f",
  );
  assert.equal(
    agentVmImage(
      { CORE_MCP_AGENT_VM_IMAGE: "custom-registry/agent-vm:override" },
      { buildNumber: "06212026-1b09617f" },
    ),
    "custom-registry/agent-vm:override",
  );
  assert.equal(agentVmImage({}, { buildNumber: "dev-build" }), "agent-vm:latest");
});

test("validateWorkspaceBind uses the exact packaged release image when no override is set", async () => {
  const calls = [];
  await validateWorkspaceBind("/Users/dionny/Documents", {
    env: {},
    buildInfo: { buildNumber: "06212026-1b09617f" },
    runCommand: async (command) => {
      calls.push(command);
      return "";
    },
  });

  assert.equal(calls.length, 1);
  assert.match(
    calls[0],
    /'harbor\.example\.invalid\/portico\/agent-vm:06212026-1b09617f'/,
  );
  assert.doesNotMatch(calls[0], /'agent-vm:latest'/);
});

test("validateWorkspaceBind mounts only the selected folder at /work", async () => {
  const calls = [];
  await validateWorkspaceBind("/Users/dionny/Documents", {
    env: { CORE_MCP_AGENT_VM_IMAGE: "agent-vm:test" },
    runCommand: async (command) => {
      calls.push(command);
      return "";
    },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0], /--volume '\/Users\/dionny\/Documents:\/work:rw'/);
  assert.doesNotMatch(calls[0], /--volume '\/Users\/dionny:\/work:rw'/);
  assert.doesNotMatch(calls[0], /--volume '\/Users:\/work:rw'/);
});

test("rebindChatAgentVms preserves vm_id while replacing the Docker container bind", async () => {
  const calls = [];
  const vmInfo = {
    vm_id: "vm-1",
    container_id: "old-container",
    chat_id: "chat-1",
    timeout_hours: 2,
    work_bind_source: "/old/workspace",
  };

  const result = await rebindChatAgentVms("chat-1", "/Users/dionny/Documents", {
    env: {
      CORE_MCP_AGENT_VM_IMAGE: "agent-vm:test",
      CORE_MCP_AGENT_VM_NETWORK: "agent-vm-net",
    },
    runCommand: async (command) => {
      calls.push(command);
      if (command.includes("redis-cli --raw --scan")) {
        return "agent_vm_info:vm-1\n";
      }
      if (command.includes("redis-cli --raw GET")) {
        return JSON.stringify(vmInfo);
      }
      if (command.includes("docker inspect --format '{{.State.Status}}'")) {
        return "running\n";
      }
      if (command.startsWith("docker create")) {
        return "temp-container-id\n";
      }
      if (command.startsWith("docker start")) {
        return "";
      }
      if (command.startsWith("docker rm -f")) {
        return "";
      }
      if (command.startsWith("docker rename")) {
        return "";
      }
      if (command.includes("docker inspect --format '{{.Id}}'")) {
        return "new-container-id\n";
      }
      if (command.includes("redis-cli SET")) {
        return "OK\n";
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.reboundCount, 1);
  assert.equal(result.rebound[0].vmId, "vm-1");
  assert.equal(result.rebound[0].containerId, "new-container-id");

  const createCommand = calls.find((command) => command.startsWith("docker create"));
  assert.match(createCommand, /--volume '\/Users\/dionny\/Documents:\/work:rw'/);
  assert.match(createCommand, /--network 'agent-vm-net'/);
  assert.match(createCommand, /agent-vm:test/);

  const redisSetCommand = calls.find((command) => command.includes("redis-cli SET"));
  assert.match(redisSetCommand, /agent_vm_info:vm-1/);
  assert.match(redisSetCommand, /"vm_id":"vm-1"/);
  assert.match(redisSetCommand, /"container_id":"new-container-id"/);
  assert.match(redisSetCommand, /"work_bind_source":"\/Users\/dionny\/Documents"/);
});

test("reconcileChatAgentVmWorkspaceBinds only recreates VMs with stale workspace binds", async () => {
  const calls = [];
  const staleVm = {
    vm_id: "vm-stale",
    container_id: "old-stale-container",
    chat_id: "chat-1",
    timeout_hours: 2,
    work_bind_source: "/old/workspace",
    work_bind_source_verified: true,
  };
  const currentVm = {
    vm_id: "vm-current",
    container_id: "current-container",
    chat_id: "chat-1",
    timeout_hours: 2,
    work_bind_source: "/Users/dionny/Documents",
    work_bind_source_verified: true,
  };

  const result = await reconcileChatAgentVmWorkspaceBinds("chat-1", "/Users/dionny/Documents", {
    env: {
      CORE_MCP_AGENT_VM_IMAGE: "agent-vm:test",
      CORE_MCP_AGENT_VM_NETWORK: "agent-vm-net",
    },
    runCommand: async (command) => {
      calls.push(command);
      if (command.includes("redis-cli --raw --scan")) {
        return "agent_vm_info:vm-stale\nagent_vm_info:vm-current\n";
      }
      if (command.includes("redis-cli --raw GET 'agent_vm_info:vm-stale'")) {
        return JSON.stringify(staleVm);
      }
      if (command.includes("redis-cli --raw GET 'agent_vm_info:vm-current'")) {
        return JSON.stringify(currentVm);
      }
      if (command.includes("docker inspect --format '{{.State.Status}}'")) {
        return "running\n";
      }
      if (command.startsWith("docker run --rm")) {
        return "";
      }
      if (command.startsWith("docker create")) {
        return "temp-container-id\n";
      }
      if (command.startsWith("docker start")) {
        return "";
      }
      if (command.startsWith("docker rm -f")) {
        return "";
      }
      if (command.startsWith("docker rename")) {
        return "";
      }
      if (command.includes("docker inspect --format '{{.Id}}'")) {
        return "new-stale-container\n";
      }
      if (command.includes("redis-cli SET")) {
        return "OK\n";
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.checkedCount, 2);
  assert.equal(result.reboundCount, 1);
  assert.equal(result.rebound[0].vmId, "vm-stale");
  assert.equal(calls.filter((command) => command.startsWith("docker create")).length, 1);
  assert.equal(calls.filter((command) => command.startsWith("docker run --rm")).length, 1);
});

test("vmNeedsWorkspaceRebind detects missing, unverified, and changed workspace metadata", () => {
  assert.equal(
    vmNeedsWorkspaceRebind(
      { work_bind_source: "/Users/dionny/Documents", work_bind_source_verified: true },
      "/Users/dionny/Documents",
    ),
    false,
  );
  assert.equal(
    vmNeedsWorkspaceRebind(
      { work_bind_source: "/Users/dionny/Documents", work_bind_source_verified: false },
      "/Users/dionny/Documents",
    ),
    true,
  );
  assert.equal(
    vmNeedsWorkspaceRebind(
      { work_bind_source: "/old/workspace", work_bind_source_verified: true },
      "/Users/dionny/Documents",
    ),
    true,
  );
});
