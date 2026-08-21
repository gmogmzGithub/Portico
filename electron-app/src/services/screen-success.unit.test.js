const test = require("node:test");
const assert = require("node:assert/strict");

function loadModule() {
  const modulePath = require.resolve(
    "../renderer/screens/guided-setup/screen-success",
  );
  delete require.cache[modulePath];
  return require("../renderer/screens/guided-setup/screen-success");
}

test("launchApp delegates completion to the Electron bridge", () => {
  const previousWindow = global.window;
  let launches = 0;
  global.window = {
    electronAPI: {
      electronAppComplete() {
        launches += 1;
      },
    },
  };

  try {
    const mod = loadModule();
    mod.launchApp();
    assert.equal(launches, 1);
  } finally {
    global.window = previousWindow;
  }
});
