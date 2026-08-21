const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");

const {
  buildClearVolumeContentsCommand,
  buildForceRemoveContainerCommand,
  buildListComposeVolumeCommand,
  buildRemoveVolumeCommand,
  buildUpContainerCommand,
  buildUpContainersCommand,
  classifyDockerComposeFailure,
  isComposeV2OrNewer,
  isDockerComposeUnavailableOutput,
  parseDockerComposeDiagnostics,
  probeDockerComposeFrontend,
  sanitizeProbeText,
  waitForContainerRunning,
  waitForContainersRunning,
  waitForDockerComposeFrontendReady,
} = require("./docker-compose-command");

test("buildUpContainerCommand appends --no-deps when requested", () => {
  const command = buildUpContainerCommand(
    "/tmp/docker-compose.sh",
    "mcpo-slack",
    { noDeps: true },
  );

  assert.equal(
    command,
    'bash "/tmp/docker-compose.sh" up-container mcpo-slack --no-deps',
  );
});

test("buildUpContainersCommand renders a batched up-containers invocation", () => {
  const command = buildUpContainersCommand(
    "/tmp/docker-compose.sh",
    ["mcpo-slack", "mcpo-sourcegraph", "mcpo-time"],
    { noDeps: true },
  );

  assert.equal(
    command,
    'bash "/tmp/docker-compose.sh" up-containers mcpo-slack mcpo-sourcegraph mcpo-time --no-deps',
  );
});

test("buildForceRemoveContainerCommand force-removes containers without stop grace delay", () => {
  const command = buildForceRemoveContainerCommand("mcpo-slack");

  assert.equal(
    command,
    'docker rm -f mcpo-slack >/dev/null 2>&1 || true',
  );
});

test("buildListComposeVolumeCommand resolves volumes by compose labels", () => {
  const command = buildListComposeVolumeCommand(
    "portico",
    "slack-mcp-cache",
  );

  assert.equal(
    command,
    "docker volume ls -q --filter label=com.docker.compose.project=portico --filter label=com.docker.compose.volume=slack-mcp-cache",
  );
});

test("buildRemoveVolumeCommand surfaces failure so callers can fall back", () => {
  const command = buildRemoveVolumeCommand("portico_slack-mcp-cache");

  assert.equal(
    command,
    "docker volume rm portico_slack-mcp-cache >/dev/null 2>&1",
  );
  assert.ok(
    !command.includes("|| true"),
    "volume removal must propagate its exit code for the fallback path",
  );
});

test("buildClearVolumeContentsCommand empties a volume via a local image", () => {
  const command = buildClearVolumeContentsCommand(
    "portico_slack-mcp-cache",
    "portico-mcp-orc-rust:latest",
  );

  assert.equal(
    command,
    "docker run --rm --entrypoint /bin/sh -v portico_slack-mcp-cache:/purge portico-mcp-orc-rust:latest -c 'find /purge -mindepth 1 -delete'",
  );
});

test("volume command builders reject missing arguments", () => {
  assert.throws(() => buildListComposeVolumeCommand("", "slack-mcp-cache"));
  assert.throws(() => buildListComposeVolumeCommand("portico", ""));
  assert.throws(() => buildRemoveVolumeCommand(""));
  assert.throws(() => buildClearVolumeContentsCommand("", "image"));
  assert.throws(() => buildClearVolumeContentsCommand("volume", ""));
});

test("Compose version parsing accepts v2+ and rejects standalone v1", () => {
  assert.equal(isComposeV2OrNewer("Docker Compose version v2.39.1"), true);
  assert.equal(isComposeV2OrNewer("Docker Compose version v5.1.2"), true);
  assert.equal(
    isComposeV2OrNewer("docker-compose version 1.29.2, build deadbeef"),
    false,
  );
});

test("probe diagnostics sanitize the user home path", () => {
  assert.equal(
    sanitizeProbeText(`${os.homedir()}/.docker/cli-plugins/docker-compose`),
    "~/.docker/cli-plugins/docker-compose",
  );
});

test("probeDockerComposeFrontend prefers the Docker plugin", async () => {
  const commands = [];
  const result = await probeDockerComposeFrontend(async (command) => {
    commands.push(command);
    return { stdout: "Docker Compose version v2.39.1\n", stderr: "" };
  });

  assert.deepEqual(commands, ["docker compose version"]);
  assert.equal(result.available, true);
  assert.equal(result.selectedFrontend, "docker-plugin");
});

test("probeDockerComposeFrontend accepts standalone v2 when plugin discovery fails", async () => {
  const commands = [];
  const result = await probeDockerComposeFrontend(async (command) => {
    commands.push(command);
    if (command === "docker compose version") {
      const error = new Error("docker: unknown command: docker compose");
      error.stderr = "docker: unknown command: docker compose\n";
      throw error;
    }
    return { stdout: "Docker Compose version v5.1.2\n", stderr: "" };
  });

  assert.deepEqual(commands, [
    "docker compose version",
    "docker-compose version",
  ]);
  assert.equal(result.available, true);
  assert.equal(result.selectedFrontend, "standalone-v2");
});

test("probeDockerComposeFrontend rejects standalone v1", async () => {
  const result = await probeDockerComposeFrontend(async (command) => {
    if (command === "docker compose version") {
      throw new Error("compose is not a docker command");
    }
    return {
      stdout: "docker-compose version 1.29.2, build deadbeef\n",
      stderr: "",
    };
  });

  assert.equal(result.available, false);
  assert.equal(result.selectedFrontend, "unavailable");
});

test("Compose failure classifier preserves marker diagnostics", () => {
  const error = new Error("start failed");
  error.stderr = [
    "DOCKER_COMPOSE_UNAVAILABLE: No usable Docker Compose v2 frontend was found.",
    "DOCKER_COMPOSE_FRONTEND=unavailable",
    "DOCKER_COMPOSE_PLUGIN_PROBE=docker: unknown command: docker compose",
    "DOCKER_COMPOSE_STANDALONE_PROBE=docker-compose version 1.29.2",
  ].join("\n");

  const result = classifyDockerComposeFailure(error);
  assert.equal(result.code, "docker_compose_unavailable");
  assert.equal(result.selectedFrontend, "unavailable");
  assert.equal(
    result.probeDiagnostics.dockerPlugin,
    "docker: unknown command: docker compose",
  );
  assert.equal(
    result.probeDiagnostics.standaloneV2,
    "docker-compose version 1.29.2",
  );
  assert.match(result.details, /DOCKER_COMPOSE_UNAVAILABLE/);
});

test("raw OrbStack flag output is classified as unavailable Compose", () => {
  const output =
    "unknown shorthand flag: 'f' in -f\n\nUsage:  docker [OPTIONS] COMMAND [ARG...]";
  assert.equal(isDockerComposeUnavailableOutput(output), true);
  assert.deepEqual(parseDockerComposeDiagnostics(output), {
    selectedFrontend: "unavailable",
    probeDiagnostics: {
      dockerPlugin: "",
      standaloneV2: "",
    },
  });
});

test("waitForDockerComposeFrontendReady returns a later standalone recovery", async () => {
  let standaloneAttempts = 0;
  const result = await waitForDockerComposeFrontendReady(
    async (command) => {
      if (command === "docker compose version") {
        throw new Error("plugin missing");
      }
      standaloneAttempts += 1;
      if (standaloneAttempts < 2) {
        throw new Error("standalone not ready");
      }
      return { stdout: "Docker Compose version v5.1.2\n", stderr: "" };
    },
    { attempts: 2, delayMs: 0 },
  );

  assert.equal(result.available, true);
  assert.equal(result.selectedFrontend, "standalone-v2");
});

test("waitForContainerRunning returns once container is running", async () => {
  const seen = [];
  const execAsync = async (command) => {
    seen.push(command);
    const index = seen.length;
    if (index < 3) {
      return { stdout: "created\n" };
    }
    return { stdout: "running\n" };
  };

  const result = await waitForContainerRunning(execAsync, "mcpo-slack", {
    attempts: 5,
    delayMs: 0,
  });

  assert.deepEqual(result, { running: true, lastStatus: "running" });
  assert.equal(seen.length, 3);
});

test("waitForContainerRunning returns last observed non-running status", async () => {
  const execAsync = async () => ({ stdout: "exited\n" });

  const result = await waitForContainerRunning(execAsync, "mcpo-slack", {
    attempts: 3,
    delayMs: 0,
  });

  assert.deepEqual(result, { running: false, lastStatus: "exited" });
});

test("waitForContainersRunning polls multiple containers concurrently", async () => {
  const seen = [];
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  const execAsync = async (command) => {
    seen.push(command);
    if (!command.includes("mcpo-sourcegraph")) {
      await gate;
    }
    return { stdout: "running\n" };
  };

  const resultPromise = waitForContainersRunning(
    execAsync,
    ["mcpo-slack", "mcpo-sourcegraph"],
    {
      attempts: 1,
      delayMs: 0,
    },
  );

  await Promise.resolve();
  assert.equal(seen.length, 2);
  releaseGate();

  const results = await resultPromise;
  assert.deepEqual(results, [
    { containerName: "mcpo-slack", running: true, lastStatus: "running" },
    {
      containerName: "mcpo-sourcegraph",
      running: true,
      lastStatus: "running",
    },
  ]);
});
