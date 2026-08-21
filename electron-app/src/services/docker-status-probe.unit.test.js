const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDockerStatusMap,
  createSerialPoller,
  parseDockerPsJsonLines,
  probeDockerStatus,
} = require("./docker-status-probe");

test("Docker status snapshot maps core and running per-server containers", () => {
  const containers = parseDockerPsJsonLines([
    JSON.stringify({ Names: "llm-gateway", State: "running" }),
    JSON.stringify({ Names: "mcpo", State: "exited" }),
    JSON.stringify({ Names: "portico-open-webui", State: "running" }),
    JSON.stringify({ Names: "mcpo-slack", State: "running" }),
    JSON.stringify({ Names: "mcpo-retired", State: "exited" }),
    JSON.stringify({ Names: "mcpo-core", State: "running" }),
  ].join("\n"));

  assert.deepEqual(buildDockerStatusMap(containers), {
    "llm-gateway": "running",
    mcpo: "stopped",
    "portico-open-webui": "running",
    "open-webui-health-check": "not_found",
    "mcpo-slack": "running",
  });
});

test("probeDockerStatus uses one direct bounded docker ps snapshot", async () => {
  const calls = [];
  const result = await probeDockerStatus({
    timeoutMs: 4321,
    runProcess: async (...args) => {
      calls.push(args);
      return {
        stdout: `${JSON.stringify({ Names: "llm-gateway", State: "running" })}\n`,
        stderr: "",
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "docker");
  assert.deepEqual(calls[0][1], ["ps", "-a", "--format", "{{json .}}"]);
  assert.equal(calls[0][2].timeoutMs, 4321);
  assert.equal(result["llm-gateway"], "running");
});

test("serial poller never overlaps ticks and schedules after completion", async () => {
  const scheduled = [];
  let runs = 0;
  let resolveRun;
  const task = () => {
    runs += 1;
    return new Promise((resolve) => {
      resolveRun = resolve;
    });
  };
  const poller = createSerialPoller(task, {
    intervalMs: 5000,
    schedule(handler, delay) {
      scheduled.push({ handler, delay });
      return scheduled.length;
    },
    cancelSchedule() {},
  });

  assert.equal(poller.start(), true);
  assert.equal(poller.start(), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.equal(scheduled.length, 0);

  resolveRun();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 5000);

  scheduled[0].handler();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 2);
  assert.equal(scheduled.length, 1);
  poller.stop();
});

test("stopping serial poller cancels an active task", async () => {
  let cancelCalls = 0;
  let resolveRun;
  const poller = createSerialPoller(
    () => new Promise((resolve) => {
      resolveRun = resolve;
    }),
    { cancelInFlight: () => { cancelCalls += 1; } },
  );

  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(poller.hasInFlightTask(), true);
  assert.equal(poller.stop(), true);
  assert.equal(cancelCalls, 1);
  resolveRun();
});
