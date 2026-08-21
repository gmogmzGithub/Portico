const test = require("node:test");
const assert = require("node:assert/strict");

const {
  clampLogLines,
  formatHostLogEntries,
  getMcpServerLogs,
} = require("./mcp-server-logs");

function installedServerOptions(options = {}) {
  return {
    isInstalledMcpServerId: () => true,
    ...options,
  };
}

test("clampLogLines defaults and clamps to the supported range", () => {
  assert.equal(clampLogLines(undefined), 200);
  assert.equal(clampLogLines("wat"), 200);
  assert.equal(clampLogLines(0), 1);
  assert.equal(clampLogLines(5000), 1000);
});

test("getMcpServerLogs returns a generic not-found result for unknown server IDs", async () => {
  const result = await getMcpServerLogs("missing-demo", {
    async execPromise() {
      throw new Error("should not inspect logs for unknown servers");
    },
    projectRoot: "/tmp/project",
    isInstalledMcpServerId() {
      return false;
    },
  });

  assert.deepEqual(result, {
    success: false,
    code: "server_not_found",
    server_id: "missing-demo",
    logs: "",
    log_source: null,
    container_name: null,
    error: "MCP server not found.",
    lines: 200,
  });
});

test("getMcpServerLogs reads host MCPO logs for true host-deployed servers", async () => {
  const result = await getMcpServerLogs("host-demo", installedServerOptions({
    async execPromise() {
      throw new Error("host log path should not invoke docker logs");
    },
    projectRoot: "/tmp/project",
    async isHostDeployedServer(serverId) {
      return serverId === "host-demo";
    },
    getConfiguredMcpoRuntimeTarget() {
      return null;
    },
    getMcpoServerContainerCandidates() {
      return [];
    },
    hostLogs: ["line-1", "line-2", "line-3"],
  }));

  assert.deepEqual(result, {
    success: true,
    server_id: "host-demo",
    logs: "line-1\nline-2\nline-3\n",
    log_source: "host_mcpo",
    container_name: null,
    lines: 200,
  });
});

test("formatHostLogEntries restores line breaks for newline-less host entries", () => {
  assert.equal(
    formatHostLogEntries(["line-1", "[ERROR] line-2", "line-3\n"]),
    "line-1\n[ERROR] line-2\nline-3\n",
  );
});

test("getMcpServerLogs awaits host detection and still prefers the managed runtime container", async () => {
  let observedCommand = null;
  const result = await getMcpServerLogs("demo", installedServerOptions({
    async isHostDeployedServer() {
      return true;
    },
    getConfiguredMcpoRuntimeTarget() {
      return { composeService: "mcpo-demo", containerName: "mcpo-demo" };
    },
    getMcpoServerContainerCandidates() {
      return ["mcpo-demo", "mcpo-single-demo"];
    },
    async execPromise(command) {
      observedCommand = command;
      return { stdout: "managed logs\n", stderr: "" };
    },
    projectRoot: "/tmp/project",
    scriptsDir: "/tmp/project/src/scripts",
    hostLogs: ["host line\n"],
  }));

  assert.equal(
    observedCommand,
    "docker logs mcpo-demo --tail 200",
  );
  assert.equal(result.success, true);
  assert.equal(result.log_source, "managed_container");
  assert.equal(result.container_name, "mcpo-demo");
  assert.equal(result.logs, "managed logs\n");
});

test("getMcpServerLogs prefers direct Docker logs for the managed runtime container", async () => {
  let observedCommand = null;
  const result = await getMcpServerLogs("demo", installedServerOptions({
    lines: 1200,
    async isHostDeployedServer() {
      return false;
    },
    getConfiguredMcpoRuntimeTarget() {
      return { composeService: "mcpo-demo", containerName: "mcpo-demo" };
    },
    getMcpoServerContainerCandidates() {
      return ["mcpo-demo", "mcpo-single-demo"];
    },
    async execPromise(command) {
      observedCommand = command;
      return { stdout: "managed stdout\n", stderr: "managed stderr\n" };
    },
    projectRoot: "/tmp/project",
    scriptsDir: "/tmp/project/src/scripts",
  }));

  assert.equal(
    observedCommand,
    "docker logs mcpo-demo --tail 1000",
  );
  assert.equal(result.success, true);
  assert.equal(result.log_source, "managed_container");
  assert.equal(result.container_name, "mcpo-demo");
  assert.equal(result.logs, "managed stdout\nmanaged stderr\n");
  assert.equal(result.lines, 1000);
});

test("getMcpServerLogs falls back to compose logs when direct Docker logs fail", async () => {
  const commands = [];
  const result = await getMcpServerLogs("demo", installedServerOptions({
    async isHostDeployedServer() {
      return false;
    },
    getConfiguredMcpoRuntimeTarget() {
      return { composeService: "mcpo-demo", containerName: "mcpo-demo" };
    },
    getMcpoServerContainerCandidates() {
      return ["mcpo-demo"];
    },
    async execPromise(command) {
      commands.push(command);
      if (command.startsWith("docker logs")) {
        throw new Error("direct logs unavailable");
      }
      return { stdout: "compose logs\n", stderr: "compose stderr\n" };
    },
    projectRoot: "/tmp/project",
    scriptsDir: "/tmp/project/src/scripts",
  }));

  assert.deepEqual(commands, [
    "docker logs mcpo-demo --tail 200",
    'bash "/tmp/project/src/scripts/docker-compose.sh" logs mcpo-demo 200',
  ]);
  assert.equal(result.success, true);
  assert.equal(result.log_source, "managed_container");
  assert.equal(result.container_name, "mcpo-demo");
  assert.equal(result.logs, "compose logs\ncompose stderr\n");
});

test("getMcpServerLogs tries direct container candidates before compose fallback", async () => {
  const commands = [];
  const result = await getMcpServerLogs("demo", installedServerOptions({
    async isHostDeployedServer() {
      return false;
    },
    getConfiguredMcpoRuntimeTarget() {
      return { composeService: "mcpo-managed-demo", containerName: "mcpo-managed-demo" };
    },
    getMcpoServerContainerCandidates() {
      return ["mcpo-managed-demo", "mcpo-single-demo"];
    },
    async execPromise(command) {
      commands.push(command);
      if (command.includes("docker logs mcpo-managed-demo")) {
        throw new Error("managed container missing");
      }
      return { stdout: "single server logs\n", stderr: "" };
    },
    projectRoot: "/tmp/project",
    scriptsDir: "/tmp/project/src/scripts",
  }));

  assert.deepEqual(commands, [
    "docker logs mcpo-managed-demo --tail 200",
    "docker logs mcpo-single-demo --tail 200",
  ]);
  assert.equal(result.success, true);
  assert.equal(result.log_source, "single_server_container");
  assert.equal(result.container_name, "mcpo-single-demo");
  assert.equal(result.logs, "single server logs\n");
});

test("getMcpServerLogs prefers the single-server container first when preferSingleServer is set", async () => {
  const commands = [];
  const result = await getMcpServerLogs("slack", installedServerOptions({
    preferSingleServer: true,
    async isHostDeployedServer() {
      return false;
    },
    getConfiguredMcpoRuntimeTarget() {
      return { composeService: "mcpo-slack", containerName: "mcpo-slack" };
    },
    getMcpoServerContainerCandidates() {
      return ["mcpo-slack", "mcpo-core-slack"];
    },
    async execPromise(command) {
      commands.push(command);
      return { stdout: "wizard logs\n", stderr: "" };
    },
    projectRoot: "/tmp/project",
    scriptsDir: "/tmp/project/src/scripts",
  }));

  // The wizard container must be the very first thing queried, ahead of the
  // managed/main-stack container, so failure diagnostics reflect the wizard.
  assert.equal(commands[0], "docker logs mcpo-single-slack --tail 200");
  assert.equal(result.success, true);
  assert.equal(result.log_source, "single_server_container");
  assert.equal(result.container_name, "mcpo-single-slack");
  assert.equal(result.logs, "wizard logs\n");
});

test("getMcpServerLogs falls back to the managed container when the wizard container is absent", async () => {
  const commands = [];
  const result = await getMcpServerLogs("slack", installedServerOptions({
    preferSingleServer: true,
    async isHostDeployedServer() {
      return false;
    },
    getConfiguredMcpoRuntimeTarget() {
      return { composeService: "mcpo-slack", containerName: "mcpo-slack" };
    },
    getMcpoServerContainerCandidates() {
      return ["mcpo-slack"];
    },
    async execPromise(command) {
      commands.push(command);
      if (command.includes("docker logs mcpo-single-slack")) {
        throw new Error("wizard stack already torn down");
      }
      return { stdout: "managed logs\n", stderr: "" };
    },
    projectRoot: "/tmp/project",
    scriptsDir: "/tmp/project/src/scripts",
  }));

  assert.deepEqual(commands, [
    "docker logs mcpo-single-slack --tail 200",
    "docker logs mcpo-slack --tail 200",
  ]);
  assert.equal(result.success, true);
  assert.equal(result.log_source, "managed_container");
  assert.equal(result.container_name, "mcpo-slack");
  assert.equal(result.logs, "managed logs\n");
});

test("getMcpServerLogs keeps managed-first ordering when preferSingleServer is not set", async () => {
  const commands = [];
  const result = await getMcpServerLogs("slack", installedServerOptions({
    async isHostDeployedServer() {
      return false;
    },
    getConfiguredMcpoRuntimeTarget() {
      return { composeService: "mcpo-slack", containerName: "mcpo-slack" };
    },
    getMcpoServerContainerCandidates() {
      return ["mcpo-slack"];
    },
    async execPromise(command) {
      commands.push(command);
      return { stdout: "managed logs\n", stderr: "" };
    },
    projectRoot: "/tmp/project",
    scriptsDir: "/tmp/project/src/scripts",
  }));

  assert.equal(commands[0], "docker logs mcpo-slack --tail 200");
  assert.equal(result.log_source, "managed_container");
  assert.equal(result.container_name, "mcpo-slack");
});

test("getMcpServerLogs merges stdout and stderr for direct docker log fallback", async () => {
  const result = await getMcpServerLogs("demo", installedServerOptions({
    async isHostDeployedServer() {
      return false;
    },
    getConfiguredMcpoRuntimeTarget() {
      return null;
    },
    getMcpoServerContainerCandidates() {
      return ["mcpo-demo"];
    },
    async execPromise() {
      return { stdout: "bootstrap lines\n", stderr: "runtime lines\n" };
    },
    projectRoot: "/tmp/project",
    scriptsDir: "/tmp/project/src/scripts",
  }));

  assert.equal(result.success, true);
  assert.equal(result.log_source, "managed_container");
  assert.equal(result.container_name, "mcpo-demo");
  assert.equal(result.logs, "bootstrap lines\nruntime lines\n");
});

test("getMcpServerLogs returns stderr/stdout fallback text when docker log retrieval fails after resolving a source", async () => {
  const error = new Error("docker logs failed");
  error.stderr = "container is restarting\n";

  const result = await getMcpServerLogs("demo", installedServerOptions({
    async isHostDeployedServer() {
      return false;
    },
    getConfiguredMcpoRuntimeTarget() {
      return null;
    },
    getMcpoServerContainerCandidates() {
      return [];
    },
    async execPromise() {
      throw error;
    },
    projectRoot: "/tmp/project",
    scriptsDir: "/tmp/project/src/scripts",
  }));

  assert.equal(result.success, true);
  assert.equal(result.log_source, "single_server_container");
  assert.equal(result.container_name, "mcpo-single-demo");
  assert.equal(result.logs, "container is restarting\n");
  assert.equal(result.warning, "docker logs failed");
});

test("getMcpServerLogs classifies a missing container as a downstream startup symptom", async () => {
  const composeError = new Error("compose logs failed");
  composeError.stderr =
    "DOCKER_COMPOSE_UNAVAILABLE: No usable Docker Compose v2 frontend was found.\n";
  const containerError = new Error("docker logs failed");
  containerError.stderr =
    "Error response from daemon: No such container: mcpo-single-google_workspace\n";
  let attempts = 0;

  const result = await getMcpServerLogs("google_workspace", installedServerOptions({
    async isHostDeployedServer() {
      return false;
    },
    getConfiguredMcpoRuntimeTarget() {
      return {
        composeService: "mcpo-google_workspace",
        containerName: "mcpo-google_workspace",
      };
    },
    getMcpoServerContainerCandidates() {
      return [];
    },
    async execPromise() {
      attempts += 1;
      throw attempts === 1 ? composeError : containerError;
    },
    projectRoot: "/tmp/project",
    scriptsDir: "/tmp/project/src/scripts",
  }));

  assert.equal(result.success, false);
  assert.equal(result.code, "container_not_created");
  assert.match(result.logs, /DOCKER_COMPOSE_UNAVAILABLE/);
  assert.match(result.logs, /No such container/);
  assert.match(result.error, /earlier startup failure/);
});
