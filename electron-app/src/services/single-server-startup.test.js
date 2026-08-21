const test = require("node:test");
const assert = require("node:assert/strict");

const {
  probeSingleServerHostListener,
  waitForSingleServerListeners,
} = require("./single-server-startup");

test("host listener probe requires backend-proxied /oauth/status", async () => {
  const calls = [];
  const result = await probeSingleServerHostListener(8770, {
    fetchImpl: async (url) => {
      calls.push(url);
      return { status: 200 };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(calls, ["http://localhost:8770/oauth/status"]);
});

test("single-server readiness accepts callback 404 once both listeners respond", async () => {
  const result = await waitForSingleServerListeners({
    hostPort: 8770,
    callbackPort: 3836,
    fetchImpl: async (url) => {
      if (url.endsWith("/")) {
        return { status: 404 };
      }
      return { status: 200 };
    },
    sleepImpl: async () => {
      assert.fail("ready listeners should not sleep");
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.hostListener.status, 200);
  assert.equal(result.callbackListener.status, 404);
});

test("host listener probe treats backend 502 as not ready", async () => {
  const result = await probeSingleServerHostListener(8770, {
    fetchImpl: async () => ({ status: 502 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.match(result.error, /backend returned HTTP 502/);
  assert.equal(result.probes.length, 1);
});

test("single-server readiness ignores nginx-only /health readiness", async () => {
  let nowMs = 0;
  const result = await waitForSingleServerListeners({
    hostPort: 8770,
    callbackPort: 3836,
    fetchImpl: async (url) => {
      if (url.endsWith("/health")) {
        return { status: 200 };
      }
      if (url.endsWith("/oauth/status")) {
        return { status: 502 };
      }
      return { status: 404 };
    },
    now: () => nowMs,
    timeoutMs: 1_000,
    pollIntervalMs: 250,
    sleepImpl: async (ms) => {
      nowMs += ms;
    },
  });

  assert.equal(result.ready, false);
  assert.match(result.error, /oauth\/status: HTTP 502/);
  assert.equal(result.hostListener.probes[0].url, "http://localhost:8770/oauth/status");
});

test("single-server readiness fails early when container exits before backend is ready", async () => {
  const result = await waitForSingleServerListeners({
    serverId: "google_workspace",
    hostPort: 8770,
    callbackPort: 3836,
    fetchImpl: async (url) => {
      if (url.includes(":8770")) {
        return { status: 502 };
      }
      return { status: 404 };
    },
    inspectContainerState: async (serverId) => {
      assert.equal(serverId, "google_workspace");
      return {
        found: true,
        status: "exited",
        running: false,
        exitCode: 1,
        restartCount: 0,
      };
    },
    getContainerLogs: async (serverId) => `logs for ${serverId}`,
    sleepImpl: async () => {
      assert.fail("container failure should fail before sleeping");
    },
  });

  assert.equal(result.ready, false);
  assert.match(result.error, /container exited before backend readiness/);
  assert.equal(result.containerState.status, "exited");
  assert.equal(result.containerLogs, "logs for google_workspace");
});

test("single-server readiness fails early when container has restarted before backend is ready", async () => {
  const result = await waitForSingleServerListeners({
    serverId: "google_workspace",
    hostPort: 8770,
    callbackPort: 3836,
    fetchImpl: async (url) => {
      if (url.includes(":8770")) {
        return { status: 502 };
      }
      return { status: 404 };
    },
    inspectContainerState: async () => ({
      found: true,
      status: "running",
      running: true,
      restartCount: 1,
    }),
    getContainerLogs: async () => "restart logs",
    sleepImpl: async () => {
      assert.fail("container restart should fail before sleeping");
    },
  });

  assert.equal(result.ready, false);
  assert.match(result.error, /restart count is 1 before backend readiness/);
  assert.equal(result.containerLogs, "restart logs");
});

test("single-server readiness returns listener diagnostics on timeout", async () => {
  let nowMs = 0;
  const result = await waitForSingleServerListeners({
    hostPort: 8770,
    callbackPort: 3836,
    fetchImpl: async (url) => {
      if (url.includes(":8770")) {
        throw new Error("host listener refused");
      }
      throw new Error("callback listener refused");
    },
    now: () => nowMs,
    timeoutMs: 1_000,
    pollIntervalMs: 250,
    sleepImpl: async (ms) => {
      nowMs += ms;
    },
  });

  assert.equal(result.ready, false);
  assert.match(result.error, /Timed out waiting for single-server listeners/);
  assert.equal(result.hostListener.ok, false);
  assert.equal(result.callbackListener.ok, false);
  assert.match(result.error, /host listener refused/);
  assert.match(result.error, /callback listener refused/);
});
