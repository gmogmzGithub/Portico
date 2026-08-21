const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runManagedProcess } = require("./managed-process");

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForProcessExit(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(pid);
}

test("runManagedProcess captures successful output", async () => {
  const result = await runManagedProcess(
    "bash",
    ["-c", "printf 'hello'; printf 'warning' >&2"],
    { timeoutMs: 2000 },
  );

  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "warning");
});

test("runManagedProcess timeout kills the entire detached process group", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process-group semantics are required for this regression");
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-process-"));
  const childPidPath = path.join(tempDir, "child.pid");
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  await assert.rejects(
    runManagedProcess(
      "bash",
      [
        "-c",
        `sleep 30 & child=$!; printf '%s' "$child" > "${childPidPath}"; wait "$child"`,
      ],
      { timeoutMs: 250, killGraceMs: 100 },
    ),
    (error) => error.timedOut === true && error.killed === true,
  );

  const childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  assert.equal(
    await waitForProcessExit(childPid),
    true,
    `nested child ${childPid} should not survive the timeout`,
  );
});

test("runManagedProcess abort kills nested children", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process-group semantics are required for this regression");
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-process-abort-"));
  const childPidPath = path.join(tempDir, "child.pid");
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const controller = new AbortController();

  const running = runManagedProcess(
    "bash",
    [
      "-c",
      `sleep 30 & child=$!; printf '%s' "$child" > "${childPidPath}"; wait "$child"`,
    ],
    { signal: controller.signal, timeoutMs: 5000, killGraceMs: 100 },
  );

  const deadline = Date.now() + 1000;
  while (!fs.existsSync(childPidPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort();

  await assert.rejects(
    running,
    (error) => error.name === "AbortError" && error.aborted === true,
  );
  const childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
  assert.equal(await waitForProcessExit(childPid), true);
});
