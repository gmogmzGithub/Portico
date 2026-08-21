const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyChatWorkspaceSelection,
  fanOutRootWorkspaceChangeToLinkedChats,
} = require("./chat-workspace-application");

test("applyChatWorkspaceSelection fans out to linked chats after the root rebind succeeds", async () => {
  const calls = [];
  const result = await applyChatWorkspaceSelection({
    projectRoot: "/tmp/project",
    chatId: "root-1",
    hostPath: "/tmp/new-root-dir",
    env: { TEST_ENV: "1" },
    getSelection: () => ({ isCustom: false, hostPath: "" }),
    setSelection: async ({ chatId, hostPath }) => ({
      chatId,
      hostPath,
      isCustom: Boolean(hostPath),
    }),
    rebind: async (chatId, hostPath) => {
      calls.push(["rebind", chatId, hostPath]);
      return { success: true, reboundCount: 0 };
    },
    fanOut: async ({ rootChatId }) => {
      calls.push(["fanOut", rootChatId]);
      return [{ chatId: "child-1", hostPath: "/tmp/new-root-dir" }];
    },
  });

  assert.deepEqual(calls, [
    ["rebind", "root-1", "/tmp/new-root-dir"],
    ["fanOut", "root-1"],
  ]);
  assert.deepEqual(result.fanOut, [
    { chatId: "child-1", hostPath: "/tmp/new-root-dir" },
  ]);
});

test("applyChatWorkspaceSelection skips fan-out when the root rebind fails and rolls back", async () => {
  const calls = [];
  let rebindAttempts = 0;
  await assert.rejects(
    applyChatWorkspaceSelection({
      projectRoot: "/tmp/project",
      chatId: "root-1",
      hostPath: "/tmp/new-root-dir",
      env: { TEST_ENV: "1" },
      getSelection: () => ({ isCustom: true, hostPath: "/tmp/previous-dir" }),
      setSelection: async ({ chatId, hostPath }) => {
        calls.push(["set", chatId, hostPath]);
        return { chatId, hostPath, isCustom: Boolean(hostPath) };
      },
      rebind: async (chatId, hostPath) => {
        rebindAttempts += 1;
        calls.push(["rebind", chatId, hostPath]);
        if (rebindAttempts === 1) {
          throw new Error("root rebind failed");
        }
      },
      fanOut: async () => {
        calls.push(["fanOut"]);
        return [];
      },
    }),
    /root rebind failed/,
  );

  assert.ok(
    !calls.some((call) => call[0] === "fanOut"),
    "fan-out must not run when the root change rolls back",
  );
  // Rollback restored the previous selection and rebound to it.
  assert.deepEqual(calls[calls.length - 2], ["set", "root-1", "/tmp/previous-dir"]);
  assert.deepEqual(calls[calls.length - 1], ["rebind", "root-1", "/tmp/previous-dir"]);
});

test("fanOutRootWorkspaceChangeToLinkedChats records child rebind failures without throwing", async () => {
  const results = await fanOutRootWorkspaceChangeToLinkedChats({
    projectRoot: "/tmp/project",
    rootChatId: "root-1",
    env: {},
    refreshSnapshots: async () => [
      { chatId: "child-broken", hostPath: "/tmp/new-root-dir" },
      { chatId: "child-ok", hostPath: "/tmp/new-root-dir" },
    ],
    rebind: async (chatId) => {
      if (chatId === "child-broken") {
        throw new Error("vm is down");
      }
    },
    getSelection: ({ chatId }) => ({ chatId, hostPath: "/tmp/new-root-dir" }),
  });

  assert.equal(results.length, 2);
  assert.match(results[0].rebindError, /vm is down/);
  assert.equal(results[0].chatId, "child-broken");
  assert.equal(results[1].rebindError, undefined);
  assert.deepEqual(results[1].selection, {
    chatId: "child-ok",
    hostPath: "/tmp/new-root-dir",
  });
});

test("fanOutRootWorkspaceChangeToLinkedChats tolerates snapshot refresh failures", async () => {
  const results = await fanOutRootWorkspaceChangeToLinkedChats({
    projectRoot: "/tmp/project",
    rootChatId: "root-1",
    env: {},
    refreshSnapshots: async () => {
      throw new Error("settings unreadable");
    },
    rebind: async () => {
      throw new Error("must not be called");
    },
  });

  assert.deepEqual(results, []);
});
