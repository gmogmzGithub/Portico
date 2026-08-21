const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const IPC_PATH = require.resolve("./ipc");

function loadTerminalNotifier() {
  const originalLoad = Module._load;
  const previousIpc = require.cache[IPC_PATH];
  const sends = [];
  const ownerWindow = {
    isDestroyed: () => false,
    webContents: {
      send(channel, payload) {
        sends.push([channel, payload]);
      },
    },
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => "/tmp" },
        ipcMain: { handle() {}, on() {} },
        shell: {},
        clipboard: {},
        BrowserWindow: {
          fromId(id) {
            return Number(id) === 7 ? ownerWindow : null;
          },
          getAllWindows() {
            return [];
          },
        },
        Notification: function Notification() {},
      };
    }
    if (
      parent?.filename === IPC_PATH &&
      (request.startsWith("./") || request.startsWith("../"))
    ) {
      return {};
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  delete require.cache[IPC_PATH];
  try {
    return { notify: require(IPC_PATH)._test.notifyNativeInputTerminal, sends };
  } finally {
    Module._load = originalLoad;
    delete require.cache[IPC_PATH];
    if (previousIpc) require.cache[IPC_PATH] = previousIpc;
  }
}

test("inline user-question completion notifies the owning window", () => {
  const { notify, sends } = loadTerminalNotifier();

  notify(7, "user_question", "question-flow-1", "submitted");

  assert.deepEqual(sends, [
    [
      "native-input-terminal",
      {
        kind: "user_question",
        flow_id: "question-flow-1",
        status: "submitted",
      },
    ],
  ]);
});
