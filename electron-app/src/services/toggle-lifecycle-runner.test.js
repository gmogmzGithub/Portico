const test = require("node:test");
const assert = require("node:assert/strict");

const { runToggleLifecycle } = require("./toggle-lifecycle-runner");

test("runToggleLifecycle awaits sync lifecycle and success hook", async () => {
  const events = [];

  const result = await runToggleLifecycle(
    async () => {
      events.push("task");
      return "ok";
    },
    {
      onSuccess: async (value) => {
        events.push(`success:${value}`);
      },
    },
  );

  assert.deepEqual(result, { queued: false, result: "ok" });
  assert.deepEqual(events, ["task", "success:ok"]);
});

test("runToggleLifecycle queues background lifecycle without blocking caller", async () => {
  const events = [];
  let releaseTask;

  const queued = await runToggleLifecycle(
    async () => {
      events.push("task");
      await new Promise((resolve) => {
        releaseTask = resolve;
      });
      return "ok";
    },
    {
      background: true,
      onSuccess: async (value) => {
        events.push(`success:${value}`);
      },
    },
  );

  assert.deepEqual(queued, { queued: true });
  assert.deepEqual(events, ["task"]);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["task"]);

  releaseTask();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["task", "success:ok"]);
});

test("runToggleLifecycle reports background failures through onError and logger", async () => {
  const events = [];

  await runToggleLifecycle(
    async () => {
      throw new Error("boom");
    },
    {
      background: true,
      onError: async (error) => {
        events.push(`error:${error.message}`);
      },
      logger: {
        error: (message) => events.push(`log:${message}`),
      },
      label: "server enable",
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    "error:boom",
    "log:[IPC] Background server enable failed: boom",
  ]);
});

test("runToggleLifecycle validates task input", async () => {
  assert.throws(
    () => runToggleLifecycle(null),
    /task \(function\) is required/,
  );
});
