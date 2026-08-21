const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPrerequisitesQuitDrain,
} = require("./prerequisites-quit-drain");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("quit proceeds synchronously when no prerequisite recovery is active", () => {
  let cancelCalls = 0;
  let continueCalls = 0;
  let prevented = false;
  const drainBeforeQuit = createPrerequisitesQuitDrain({
    cancelPrerequisites() {
      cancelCalls += 1;
      return null;
    },
    continueQuit() {
      continueCalls += 1;
    },
  });

  const delayed = drainBeforeQuit({
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(delayed, false);
  assert.equal(prevented, false);
  assert.equal(cancelCalls, 1);
  assert.equal(continueCalls, 0);
});

test("quit remains prevented until the managed prerequisite recovery closes", async () => {
  const recoveryClose = deferred();
  let cancelCalls = 0;
  let continueCalls = 0;
  let drainErrors = 0;
  let preventCalls = 0;
  const drainBeforeQuit = createPrerequisitesQuitDrain({
    cancelPrerequisites() {
      cancelCalls += 1;
      return recoveryClose.promise;
    },
    continueQuit() {
      continueCalls += 1;
    },
    onDrainError() {
      drainErrors += 1;
    },
  });
  const quitEvent = {
    preventDefault() {
      preventCalls += 1;
    },
  };

  assert.equal(drainBeforeQuit(quitEvent), true);
  assert.equal(drainBeforeQuit(quitEvent), true);
  assert.equal(cancelCalls, 1);
  assert.equal(preventCalls, 2);
  assert.equal(continueCalls, 0);

  recoveryClose.resolve();
  await recoveryClose.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(continueCalls, 1);
  assert.equal(drainErrors, 0);
  assert.equal(drainBeforeQuit(quitEvent), false);
  assert.equal(preventCalls, 2);
  assert.equal(cancelCalls, 1);
});

test("a failed recovery still resumes quit only after its close promise settles", async () => {
  const recoveryClose = deferred();
  const observedErrors = [];
  let continueCalls = 0;
  const drainBeforeQuit = createPrerequisitesQuitDrain({
    cancelPrerequisites: () => recoveryClose.promise,
    continueQuit() {
      continueCalls += 1;
    },
    onDrainError(error) {
      observedErrors.push(error);
    },
  });

  assert.equal(drainBeforeQuit({ preventDefault() {} }), true);
  const failure = new Error("repair closed with failure");
  recoveryClose.reject(failure);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(observedErrors, [failure]);
  assert.equal(continueCalls, 1);
});
