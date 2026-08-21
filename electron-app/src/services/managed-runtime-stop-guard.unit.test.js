const test = require("node:test");
const assert = require("node:assert");

const {
  stopOutputIndicatesNothingToStop,
  classifyManagedRuntimeStop,
  stopManagedRuntimeForUpdate,
} = require("./managed-runtime-stop-guard");

// ---------------------------------------------------------------------------
// PORTICO-323 regression: the pre-apply stop guard must treat "nothing to stop"
// (fresh install stub root, or Docker/OrbStack down) as safe-to-proceed, and
// still refuse on a genuine stop failure while services may be live.
// ---------------------------------------------------------------------------

test("a clean successful stop is safe to proceed", () => {
  const verdict = classifyManagedRuntimeStop({
    scriptExists: true,
    stopResult: { success: true },
  });
  assert.equal(verdict.safeToProceed, true);
  assert.equal(verdict.reason, "stopped");
});

test("a missing stop script (stub managed root) is safe to proceed", () => {
  const verdict = classifyManagedRuntimeStop({
    scriptExists: false,
    stopResult: {
      success: false,
      error: "managed runtime stop script not present: /x/docker-compose.sh",
    },
  });
  assert.equal(verdict.safeToProceed, true);
  assert.equal(verdict.reason, "stop-script-absent");
});

test("the app-owned stop operation skips a missing script without loading a command runner", async () => {
  const result = await stopManagedRuntimeForUpdate({
    stopScriptPath: "/missing/docker-compose.sh",
    scriptExists: false,
  });
  assert.deepEqual(result, {
    success: true,
    skipped: true,
    reason: "stop-script-absent",
  });
});

test("bash exit 127 (No such file or directory) is safe to proceed", () => {
  // The exact signature from the PORTICO-323 field bundles: the app shelled
  // `bash <stub>/src/scripts/docker-compose.sh stop` and bash could not exec it.
  const verdict = classifyManagedRuntimeStop({
    scriptExists: true,
    stopScriptPath:
      "/Users/x/portico/portico-managed/src/scripts/docker-compose.sh",
    stopResult: {
      success: false,
      code: 127,
      error:
        "bash: /Users/x/portico/portico-managed/src/scripts/docker-compose.sh: No such file or directory",
    },
  });
  assert.equal(verdict.safeToProceed, true);
  assert.equal(verdict.reason, "stop-script-absent");
});

test("exit 127 from inside an existing stop script still fails closed", () => {
  const verdict = classifyManagedRuntimeStop({
    scriptExists: true,
    stopScriptPath: "/managed/src/scripts/docker-compose.sh",
    stopResult: {
      success: false,
      code: 127,
      error: "line 42: helper-command: command not found",
    },
  });
  assert.equal(verdict.safeToProceed, false);
  assert.equal(verdict.reason, "stop-failed");
});

test("Docker/OrbStack down (check_docker) is safe to proceed", () => {
  const verdict = classifyManagedRuntimeStop({
    scriptExists: true,
    stopResult: { success: false, code: 1, error: "Docker is not running" },
  });
  assert.equal(verdict.safeToProceed, true);
  assert.equal(verdict.reason, "nothing-to-stop");
});

test("docker daemon unreachable is safe to proceed", () => {
  const verdict = classifyManagedRuntimeStop({
    scriptExists: true,
    stopResult: {
      success: false,
      error:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    },
  });
  assert.equal(verdict.safeToProceed, true);
});

test("a genuine stop failure while services may be live must refuse", () => {
  const verdict = classifyManagedRuntimeStop({
    scriptExists: true,
    stopResult: { success: false, error: "container refused to stop" },
  });
  assert.equal(verdict.safeToProceed, false);
  assert.equal(verdict.reason, "stop-failed");
  assert.equal(verdict.error, "container refused to stop");
});

test("stopOutputIndicatesNothingToStop matches daemon-down / missing-script signatures only", () => {
  assert.equal(stopOutputIndicatesNothingToStop("Docker is not running"), true);
  assert.equal(
    stopOutputIndicatesNothingToStop("bash: docker-compose.sh: No such file or directory"),
    false,
  );
  assert.equal(stopOutputIndicatesNothingToStop("OrbStack is not installed"), true);
  // A real failure of a running stack must NOT be swallowed.
  assert.equal(stopOutputIndicatesNothingToStop("container refused to stop"), false);
  assert.equal(stopOutputIndicatesNothingToStop(""), false);
  assert.equal(stopOutputIndicatesNothingToStop(undefined), false);
});

test("a broken Compose plugin is safe only after proving the app project has no containers", async () => {
  const calls = [];
  const result = await stopManagedRuntimeForUpdate({
    stopScriptPath: "/managed/src/scripts/docker-compose.sh",
    scriptExists: true,
    executeWithStreaming: async (command, args) => {
      calls.push([command, args]);
      if (command.startsWith("bash ")) {
        return {
          success: false,
          code: 125,
          error:
            "unknown shorthand flag: 'p' in -p\nUsage: docker [OPTIONS] COMMAND [ARG...]",
        };
      }
      assert.equal(command, "docker");
      return { success: true, output: "\n" };
    },
  });

  assert.deepEqual(result, {
    success: true,
    skipped: true,
    reason: "no-project-containers",
  });
  assert.deepEqual(calls, [
    ['bash "/managed/src/scripts/docker-compose.sh"', ["stop"]],
    [
      "docker",
      [
        "ps",
        "-aq",
        "--filter",
        "label=com.docker.compose.project=portico",
      ],
    ],
  ]);
});

test("a broken Compose plugin falls back to standalone v2 and verifies containers stopped", async () => {
  const calls = [];
  let containerProbe = 0;
  const result = await stopManagedRuntimeForUpdate({
    stopScriptPath: "/managed/src/scripts/docker-compose.sh",
    scriptExists: true,
    executeWithStreaming: async (command, args) => {
      calls.push([command, args]);
      if (command.startsWith("bash ")) {
        return {
          success: false,
          code: 125,
          error: "unknown shorthand flag: 'p' in -p",
        };
      }
      if (command === "docker") {
        containerProbe += 1;
        return {
          success: true,
          output: containerProbe === 1 ? "live-container\n" : "",
        };
      }
      if (args[0] === "version") {
        return { success: true, output: "Docker Compose version v5.1.2\n" };
      }
      return { success: true, output: "project stopped\n" };
    },
  });

  assert.deepEqual(result, {
    success: true,
    reason: "standalone-compose-stopped",
  });
  assert.deepEqual(calls[2], ["docker-compose", ["version"]]);
  assert.deepEqual(calls[3], [
    "docker-compose",
    ["-p", "portico", "down", "--remove-orphans"],
  ]);
  assert.equal(containerProbe, 2);
});

test("standalone fallback still refuses when an app project container remains", async () => {
  const calls = [];
  const result = await stopManagedRuntimeForUpdate({
    stopScriptPath: "/managed/src/scripts/docker-compose.sh",
    scriptExists: true,
    executeWithStreaming: async (command, args) => {
      calls.push([command, args]);
      if (command.startsWith("bash ")) {
        return {
          success: false,
          error: "DOCKER_COMPOSE_UNAVAILABLE: broken plugin",
        };
      }
      if (command === "docker") {
        return { success: true, output: "still-live\n" };
      }
      if (args[0] === "version") {
        return { success: true, output: "Docker Compose version v2.39.1\n" };
      }
      return { success: true, output: "standalone stop completed" };
    },
  });

  assert.deepEqual(result, {
    success: false,
    error: "Managed runtime containers remain after the standalone Compose stop.",
  });
  assert.deepEqual(calls.at(-1), [
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      "label=com.docker.compose.project=portico",
    ],
  ]);
});

test("container inspection failure never attempts standalone Compose", async () => {
  const calls = [];
  const result = await stopManagedRuntimeForUpdate({
    stopScriptPath: "/managed/src/scripts/docker-compose.sh",
    scriptExists: true,
    executeWithStreaming: async (command, args) => {
      calls.push([command, args]);
      if (command.startsWith("bash ")) {
        return {
          success: false,
          error: "unknown shorthand flag: 'p' in -p",
        };
      }
      return { success: false, error: "container inspection failed" };
    },
  });

  assert.deepEqual(result, {
    success: false,
    error: "container inspection failed",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls.some(([command]) => command === "docker-compose"), false);
});

test("a failed final container inspection fails closed after standalone stop", async () => {
  let containerProbe = 0;
  const result = await stopManagedRuntimeForUpdate({
    stopScriptPath: "/managed/src/scripts/docker-compose.sh",
    scriptExists: true,
    executeWithStreaming: async (command, args) => {
      if (command.startsWith("bash ")) {
        return {
          success: false,
          error: "unknown shorthand flag: 'p' in -p",
        };
      }
      if (command === "docker") {
        containerProbe += 1;
        return containerProbe === 1
          ? { success: true, output: "live-container\n" }
          : { success: false, error: "final inspection failed" };
      }
      if (args[0] === "version") {
        return { success: true, output: "Docker Compose version v2.39.1\n" };
      }
      return { success: true };
    },
  });

  assert.deepEqual(result, {
    success: false,
    error: "final inspection failed",
  });
});

test("a generic Docker usage banner alone does not enter Compose recovery", async () => {
  const calls = [];
  const result = await stopManagedRuntimeForUpdate({
    stopScriptPath: "/managed/src/scripts/docker-compose.sh",
    scriptExists: true,
    executeWithStreaming: async (command, args) => {
      calls.push([command, args]);
      return {
        success: false,
        error: "Usage: docker [OPTIONS] COMMAND [ARG...]",
      };
    },
  });

  // PORTICO-373: timedOut is part of the contract now -- callers key automatic engine
  // recovery off it, and a stop that exited immediately (as here) must report
  // false so a usage banner can never trigger a container-engine restart.
  assert.deepEqual(result, {
    success: false,
    error: "Usage: docker [OPTIONS] COMMAND [ARG...]",
    timedOut: false,
  });
  assert.equal(calls.length, 1);
});

test("fallback commands share one total timeout budget", async () => {
  let nowMs = 1000;
  const seenTimeouts = [];
  const result = await stopManagedRuntimeForUpdate({
    stopScriptPath: "/managed/src/scripts/docker-compose.sh",
    scriptExists: true,
    timeoutMs: 100,
    now: () => nowMs,
    executeWithStreaming: async (command, args, timeoutMs) => {
      seenTimeouts.push(timeoutMs);
      nowMs += 25;
      if (command.startsWith("bash ")) {
        return {
          success: false,
          error: "unknown shorthand flag: 'p' in -p",
        };
      }
      if (command === "docker") {
        return { success: true, output: "live-container\n" };
      }
      if (args[0] === "version") {
        return { success: true, output: "Docker Compose version v2.39.1\n" };
      }
      return { success: true };
    },
  });

  assert.deepEqual(seenTimeouts, [100, 75, 50, 25]);
  assert.deepEqual(result, {
    success: false,
    error: "Managed runtime stop timed out.",
  });
});
