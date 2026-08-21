const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  buildWorkspaceFileUrl,
  collapseHomePath,
  encodeWorkspaceUrlSegment,
  ensureChatWorkspaceDirectories,
  getChatWorkspaceSelection,
  moveChatWorkspaceSelection,
  resolveChatWorkspaceEntryPath,
  resolveChatWorkspaceEntryPathWithSkillAssetFallback,
  resolveChatWorkspacePath,
  setChatWorkspaceSelection,
} = require("./chat-workspaces");

test("resolveChatWorkspacePath returns the repo-local chat workspace layout", () => {
  const result = resolveChatWorkspacePath({
    projectRoot: "/tmp/project-root",
    chatId: "chat-123",
  });

  assert.deepEqual(result, {
    workspacesDir: path.resolve("/tmp/project-root/workspaces"),
    chatWorkspace: path.resolve("/tmp/project-root/workspaces/chat-123"),
    canonicalChatWorkspace: path.resolve("/tmp/project-root/workspaces/chat-123"),
    source: "canonical",
    isCustom: false,
    isUserSelectedCustom: false,
    displayPath: "",
    inheritedWorkspace: false,
    inheritedFromChatId: "",
    rootParentChatId: "",
    linkedWorkspace: false,
  });
});

test("resolveChatWorkspacePath rejects missing and traversal chat ids", () => {
  assert.throws(
    () => resolveChatWorkspacePath({ projectRoot: "/tmp/project-root", chatId: "" }),
    /chatId is required/,
  );
  assert.throws(
    () =>
      resolveChatWorkspacePath({
        projectRoot: "/tmp/project-root",
        chatId: "../other-chat",
      }),
    /outside workspaces directory/,
  );
});

test("resolveChatWorkspaceEntryPath rejects traversal outside the chat workspace", () => {
  assert.throws(
    () =>
      resolveChatWorkspaceEntryPath({
        projectRoot: "/tmp/project-root",
        chatId: "chat-123",
        relativePath: "../chat-999/secrets.txt",
      }),
    /outside chat workspace/,
  );
});

test("skill-asset fallback resolver exposes the canonical copy only for custom skill-asset paths", () => {
  const io = {
    env: {},
    existsSync: () => true,
    readFileSync: () =>
      JSON.stringify({
        chats: {
          "chat-123": { source: "custom", host_path: "/tmp/custom folder" },
        },
      }),
  };

  const skillAsset = resolveChatWorkspaceEntryPathWithSkillAssetFallback({
    projectRoot: "/tmp/project-root",
    chatId: "chat-123",
    relativePath: "skill-assets/snowflake-setup/step-1.png",
    ...io,
  });
  assert.equal(
    skillAsset.targetPath,
    path.resolve("/tmp/custom folder/skill-assets/snowflake-setup/step-1.png"),
  );
  assert.equal(
    skillAsset.skillAssetFallbackPath,
    path.resolve(
      "/tmp/project-root/workspaces/chat-123/skill-assets/snowflake-setup/step-1.png",
    ),
  );

  const regularFile = resolveChatWorkspaceEntryPathWithSkillAssetFallback({
    projectRoot: "/tmp/project-root",
    chatId: "chat-123",
    relativePath: "output/report.md",
    ...io,
  });
  assert.equal(regularFile.targetPath, path.resolve("/tmp/custom folder/output/report.md"));
  assert.equal(regularFile.skillAssetFallbackPath, null);

  // In-workspace paths that escape the skill-assets/ prefix never fall back.
  const escapesPrefix = resolveChatWorkspaceEntryPathWithSkillAssetFallback({
    projectRoot: "/tmp/project-root",
    chatId: "chat-123",
    relativePath: "skill-assets/../report.md",
    ...io,
  });
  assert.equal(escapesPrefix.skillAssetFallbackPath, null);

  // Traversal outside the selected workspace still throws (403 upstream).
  assert.throws(
    () =>
      resolveChatWorkspaceEntryPathWithSkillAssetFallback({
        projectRoot: "/tmp/project-root",
        chatId: "chat-123",
        relativePath: "skill-assets/../../outside/secret.txt",
        ...io,
      }),
    /outside chat workspace/,
  );

  // Canonical-workspace chats never gain a fallback path.
  const canonicalChat = resolveChatWorkspaceEntryPathWithSkillAssetFallback({
    projectRoot: "/tmp/project-root",
    chatId: "chat-999",
    relativePath: "skill-assets/snowflake-setup/step-1.png",
    env: {},
    existsSync: () => false,
  });
  assert.equal(canonicalChat.isCustom, false);
  assert.equal(canonicalChat.skillAssetFallbackPath, null);
  assert.equal(
    canonicalChat.targetPath,
    path.resolve(
      "/tmp/project-root/workspaces/chat-999/skill-assets/snowflake-setup/step-1.png",
    ),
  );
});

test("encodeWorkspaceUrlSegment escapes markdown-sensitive URL characters", () => {
  assert.equal(
    encodeWorkspaceUrlSegment("diagram (v2)#1%.md"),
    "diagram%20%28v2%29%231%25.md",
  );
  assert.equal(encodeWorkspaceUrlSegment("résumé.md"), "r%C3%A9sum%C3%A9.md");
});

test("buildWorkspaceFileUrl encodes nested workspace paths without collapsing separators", () => {
  assert.equal(
    buildWorkspaceFileUrl({
      host: "localhost",
      port: 9876,
      chatId: "chat-123",
      filePath: "output/reports/Agg Disco Pipeline 2025 Overview (v2)#1%.md",
    }),
    "http://localhost:9876/workspace/chat-123/output/reports/Agg%20Disco%20Pipeline%202025%20Overview%20%28v2%29%231%25.md",
  );
  assert.equal(
    buildWorkspaceFileUrl({
      host: "127.0.0.1",
      port: 4567,
      chatId: "chat-123",
      filePath: "nested/diagram résumé.md",
    }),
    "http://127.0.0.1:4567/workspace/chat-123/nested/diagram%20r%C3%A9sum%C3%A9.md",
  );
});

test("ensureChatWorkspaceDirectories creates the chat workspace root", async () => {
  const mkdirCalls = [];

  const result = await ensureChatWorkspaceDirectories({
    projectRoot: "/tmp/project-root",
    chatId: "chat-123",
    mkdir: async (targetPath, options) => {
      mkdirCalls.push({ targetPath, options });
    },
  });

  assert.equal(
    result.chatWorkspace,
    path.resolve("/tmp/project-root/workspaces/chat-123"),
  );
  assert.equal(result.isUserSelectedCustom, false);
  assert.deepEqual(mkdirCalls, [
    {
      targetPath: path.resolve("/tmp/project-root/workspaces/chat-123"),
      options: { recursive: true },
    },
  ]);
});

test("setChatWorkspaceSelection stores an exact custom folder per chat", async () => {
  let stored = "";
  const writes = [];
  const io = {
    env: {},
    existsSync: (targetPath) => targetPath.endsWith("chat-workspaces.json") && stored !== "",
    readFileSync: () => stored,
    mkdir: async (targetPath, options) => {
      writes.push({ type: "mkdir", targetPath, options });
    },
    writeFile: async (targetPath, content) => {
      writes.push({ type: "write", targetPath, content });
      stored = content;
    },
    now: () => new Date("2026-05-12T12:00:00.000Z"),
  };

  const selection = await setChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    chatId: "chat-123",
    hostPath: "/tmp/custom folder",
    ...io,
  });

  assert.equal(selection.source, "custom");
  assert.equal(selection.isUserSelectedCustom, true);
  assert.equal(selection.hostPath, path.resolve("/tmp/custom folder"));
  assert.equal(JSON.parse(stored).chats["chat-123"].host_path, path.resolve("/tmp/custom folder"));
  assert.equal(writes[0].targetPath, path.resolve("/tmp/project-root/open-webui-data/workspace-cfg"));

  const resolved = resolveChatWorkspaceEntryPath({
    projectRoot: "/tmp/project-root",
    chatId: "chat-123",
    relativePath: "report.md",
    ...io,
  });
  assert.equal(resolved.targetPath, path.resolve("/tmp/custom folder/report.md"));
});

test("a cloned chat starts canonical and workspace changes stay isolated per chat", async () => {
  let stored = JSON.stringify({
    chats: {
      "original-chat": {
        source: "custom",
        host_path: "/tmp/original-a",
      },
    },
  });
  const io = {
    env: {},
    existsSync: () => true,
    readFileSync: () => stored,
    mkdir: async () => {},
    writeFile: async (_targetPath, content) => {
      stored = content;
    },
  };

  const originalBefore = getChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    chatId: "original-chat",
    ...io,
  });
  const cloneBefore = getChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    chatId: "cloned-chat",
    ...io,
  });
  assert.equal(originalBefore.hostPath, path.resolve("/tmp/original-a"));
  assert.equal(cloneBefore.source, "canonical");
  assert.equal(cloneBefore.hostPath, path.resolve("/tmp/project-root/workspaces/cloned-chat"));

  await setChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    chatId: "original-chat",
    hostPath: "/tmp/original-b",
    ...io,
  });
  await setChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    chatId: "cloned-chat",
    hostPath: "/tmp/clone-c",
    ...io,
  });

  const settings = JSON.parse(stored);
  assert.equal(settings.chats["original-chat"].host_path, path.resolve("/tmp/original-b"));
  assert.equal(settings.chats["cloned-chat"].host_path, path.resolve("/tmp/clone-c"));
});

test("resolveChatWorkspacePath reads and migrates legacy repo settings into workspace cfg", () => {
  const legacySettingsPath = path.resolve(
    "/tmp/project-root/open-webui-data/app-support/chat-workspaces.json",
  );
  const runtimeSettingsPath = path.resolve("/tmp/runtime-workspace-cfg/chat-workspaces.json");
  const legacySettings = JSON.stringify({
    chats: {
      "chat-123": {
        source: "custom",
        host_path: "/tmp/custom workspace",
      },
    },
  });
  const writes = [];

  const result = resolveChatWorkspacePath({
    projectRoot: "/tmp/project-root",
    chatId: "chat-123",
    env: { PORTICO_WORKSPACE_CFG_DIR: "/tmp/runtime-workspace-cfg" },
    existsSync: (targetPath) => path.resolve(targetPath) === legacySettingsPath,
    readFileSync: (targetPath) => {
      assert.equal(path.resolve(targetPath), legacySettingsPath);
      return legacySettings;
    },
    mkdirSync: (targetPath, options) => {
      writes.push({ type: "mkdir", targetPath: path.resolve(targetPath), options });
    },
    writeFileSync: (targetPath, content) => {
      writes.push({ type: "write", targetPath: path.resolve(targetPath), content });
    },
  });

  assert.equal(result.source, "custom");
  assert.equal(result.chatWorkspace, path.resolve("/tmp/custom workspace"));
  assert.deepEqual(writes, [
    {
      type: "mkdir",
      targetPath: path.dirname(runtimeSettingsPath),
      options: { recursive: true },
    },
    {
      type: "write",
      targetPath: runtimeSettingsPath,
      content: `${JSON.stringify(JSON.parse(legacySettings), null, 2)}\n`,
    },
  ]);
});

test("workspace cfg override does not require a legacy app-support root", () => {
  const result = resolveChatWorkspacePath({
    projectRoot: "/tmp/project-root",
    chatId: "chat-123",
    env: { PORTICO_WORKSPACE_CFG_DIR: "/tmp/runtime-workspace-cfg" },
    existsSync: () => false,
  });

  assert.equal(result.source, "canonical");
  assert.equal(result.isUserSelectedCustom, false);
  assert.equal(result.chatWorkspace, path.resolve("/tmp/project-root/workspaces/chat-123"));
});

test("getChatWorkspaceSelection exposes inherited subagent workspace metadata", () => {
  const stored = JSON.stringify({
    chats: {
      "child-chat": {
        source: "custom",
        host_path: "/tmp/project-root/workspaces/root-chat",
        selected_at: "2026-05-14T12:00:00.000Z",
        inherited_workspace: true,
        inherited_from_chat_id: "parent-subagent",
        root_parent_chat_id: "root-chat",
      },
    },
  });

  const selection = getChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    chatId: "child-chat",
    env: {},
    existsSync: () => true,
    readFileSync: () => stored,
  });

  assert.equal(selection.isCustom, true);
  assert.equal(selection.isUserSelectedCustom, false);
  assert.equal(selection.hostPath, path.resolve("/tmp/project-root/workspaces/root-chat"));
  assert.equal(selection.inheritedWorkspace, true);
  assert.equal(selection.inheritedFromChatId, "parent-subagent");
  assert.equal(selection.rootParentChatId, "root-chat");
});

test("inherited user-selected root workspace remains composer-visible", () => {
  const customWorkspace = path.resolve("/tmp/custom-root-workspace");
  const stored = JSON.stringify({
    chats: {
      "root-chat": {
        source: "custom",
        host_path: customWorkspace,
      },
      "child-chat": {
        source: "custom",
        host_path: customWorkspace,
        inherited_workspace: true,
        inherited_from_chat_id: "root-chat",
        root_parent_chat_id: "root-chat",
      },
    },
  });

  const selection = getChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    chatId: "child-chat",
    env: {},
    existsSync: () => true,
    readFileSync: () => stored,
  });

  assert.equal(selection.isCustom, true);
  assert.equal(selection.isUserSelectedCustom, true);
  assert.equal(selection.hostPath, customWorkspace);
});

test("nested subagent inheritance keeps the root custom workspace composer-visible", () => {
  const customWorkspace = path.resolve("/tmp/nested-root-workspace");
  const stored = JSON.stringify({
    chats: {
      "root-chat": {
        source: "custom",
        host_path: customWorkspace,
      },
      "parent-subagent": {
        source: "custom",
        host_path: customWorkspace,
        inherited_workspace: true,
        inherited_from_chat_id: "root-chat",
        root_parent_chat_id: "root-chat",
      },
      "child-subagent": {
        source: "custom",
        host_path: customWorkspace,
        inherited_workspace: true,
        inherited_from_chat_id: "parent-subagent",
        root_parent_chat_id: "root-chat",
      },
    },
  });

  const selection = getChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    chatId: "child-subagent",
    env: {},
    existsSync: () => true,
    readFileSync: () => stored,
  });

  assert.equal(selection.isUserSelectedCustom, true);
  assert.equal(selection.inheritedFromChatId, "parent-subagent");
  assert.equal(selection.rootParentChatId, "root-chat");
});

test("legacy inherited noncanonical workspace remains composer-visible without a root entry", () => {
  const customWorkspace = path.resolve("/tmp/legacy-custom-workspace");
  const stored = JSON.stringify({
    chats: {
      "child-chat": {
        source: "custom",
        host_path: customWorkspace,
        inherited_workspace: true,
        inherited_from_chat_id: "parent-subagent",
        root_parent_chat_id: "root-chat",
      },
    },
  });

  const selection = getChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    chatId: "child-chat",
    env: {},
    existsSync: () => true,
    readFileSync: () => stored,
  });

  assert.equal(selection.isUserSelectedCustom, true);
});

test("clearing custom workspace falls back to canonical chat root", async () => {
  let stored = JSON.stringify({
    chats: {
      "chat-123": {
        source: "custom",
        host_path: "/tmp/custom",
      },
    },
  });
  const io = {
    env: {},
    existsSync: () => true,
    readFileSync: () => stored,
    mkdir: async () => {},
    writeFile: async (_targetPath, content) => {
      stored = content;
    },
  };

  const selection = await setChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    chatId: "chat-123",
    hostPath: null,
    ...io,
  });

  assert.equal(selection.source, "canonical");
  assert.equal(selection.hostPath, path.resolve("/tmp/project-root/workspaces/chat-123"));
  assert.deepEqual(JSON.parse(stored).chats, {});
});

test("moveChatWorkspaceSelection moves a custom folder to the final chat id", async () => {
  let stored = JSON.stringify({
    chats: {
      "pending-chat": {
        source: "custom",
        host_path: "/tmp/custom workspace",
        selected_at: "2026-05-12T12:00:00.000Z",
      },
    },
  });
  const io = {
    env: {},
    existsSync: () => true,
    readFileSync: () => stored,
    mkdir: async () => {},
    writeFile: async (_targetPath, content) => {
      stored = content;
    },
    now: () => new Date("2026-05-12T13:00:00.000Z"),
  };

  const result = await moveChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    fromChatId: "pending-chat",
    toChatId: "final-chat",
    ...io,
  });

  const parsed = JSON.parse(stored);
  assert.equal(result.moved, true);
  assert.equal(result.selection.hostPath, path.resolve("/tmp/custom workspace"));
  assert.equal(parsed.chats["final-chat"].host_path, path.resolve("/tmp/custom workspace"));
  assert.equal(parsed.chats["final-chat"].selected_at, "2026-05-12T12:00:00.000Z");
  assert.equal(parsed.chats["pending-chat"], undefined);
});

test("moveChatWorkspaceSelection no-ops when the source has no custom folder", async () => {
  let stored = JSON.stringify({ chats: {} });
  const io = {
    env: {},
    existsSync: () => true,
    readFileSync: () => stored,
    mkdir: async () => {},
    writeFile: async (_targetPath, content) => {
      stored = content;
    },
  };

  const result = await moveChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    fromChatId: "pending-chat",
    toChatId: "final-chat",
    ...io,
  });

  assert.equal(result.moved, false);
  assert.equal(result.selection.source, "canonical");
  assert.deepEqual(JSON.parse(stored).chats, {});
});

test("moveChatWorkspaceSelection no-ops when ids are missing or equal", async () => {
  const equalResult = await moveChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    fromChatId: "chat-123",
    toChatId: "chat-123",
  });
  const missingResult = await moveChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    fromChatId: "",
    toChatId: "chat-123",
  });

  assert.deepEqual(equalResult, {
    moved: false,
    fromChatId: "chat-123",
    toChatId: "chat-123",
  });
  assert.deepEqual(missingResult, {
    moved: false,
    fromChatId: "",
    toChatId: "chat-123",
  });
});

test("collapseHomePath uses tilde for paths under the user home", () => {
  assert.equal(collapseHomePath("/Users/dionny/Documents", "/Users/dionny"), "~/Documents");
  assert.equal(collapseHomePath("/Users/dionny", "/Users/dionny"), "~");
});

test("linked workspace follows the root chat's current custom binding", () => {
  const stored = JSON.stringify({
    chats: {
      "root-chat": {
        source: "custom",
        host_path: "/tmp/root-current-dir",
      },
      "child-chat": {
        source: "custom",
        host_path: "/tmp/stale-snapshot",
        linked_workspace: true,
        inherited_from_chat_id: "root-chat",
        root_parent_chat_id: "root-chat",
      },
    },
  });

  const selection = getChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    chatId: "child-chat",
    env: {},
    existsSync: () => true,
    readFileSync: () => stored,
  });

  assert.equal(selection.isCustom, true);
  assert.equal(selection.linkedWorkspace, true);
  assert.equal(selection.hostPath, path.resolve("/tmp/root-current-dir"));
  assert.equal(selection.isUserSelectedCustom, true);
  assert.equal(selection.rootParentChatId, "root-chat");
});

test("linked workspace resolves to the root's generated dir when the root has no entry", () => {
  const stored = JSON.stringify({
    chats: {
      "child-chat": {
        source: "custom",
        host_path: "/tmp/stale-snapshot",
        linked_workspace: true,
        inherited_from_chat_id: "root-chat",
        root_parent_chat_id: "root-chat",
      },
    },
  });

  const selection = getChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    chatId: "child-chat",
    env: {},
    existsSync: () => true,
    readFileSync: () => stored,
  });

  assert.equal(selection.linkedWorkspace, true);
  assert.equal(
    selection.hostPath,
    path.resolve("/tmp/project-root/workspaces/root-chat"),
  );
  assert.equal(selection.isUserSelectedCustom, false);
});

test("linked workspace keeps the snapshot when the root entry is itself linked", () => {
  const stored = JSON.stringify({
    chats: {
      "root-chat": {
        source: "custom",
        host_path: "/tmp/elsewhere",
        linked_workspace: true,
        root_parent_chat_id: "even-deeper",
      },
      "child-chat": {
        source: "custom",
        host_path: "/tmp/stale-snapshot",
        linked_workspace: true,
        root_parent_chat_id: "root-chat",
      },
    },
  });

  const selection = getChatWorkspaceSelection({
    projectRoot: "/tmp/project-root",
    chatId: "child-chat",
    env: {},
    existsSync: () => true,
    readFileSync: () => stored,
  });

  assert.equal(selection.hostPath, path.resolve("/tmp/stale-snapshot"));
});

test("ensureChatWorkspaceDirectories creates the shared generated dir for linked chats", async () => {
  const os = require("node:os");
  const fsNative = require("node:fs");
  const tempRoot = fsNative.mkdtempSync(path.join(os.tmpdir(), "linked-ws-"));
  const cfgDir = path.join(tempRoot, "workspace-cfg");
  fsNative.mkdirSync(cfgDir, { recursive: true });
  fsNative.writeFileSync(
    path.join(cfgDir, "chat-workspaces.json"),
    JSON.stringify({
      chats: {
        "child-chat": {
          source: "custom",
          host_path: path.join(tempRoot, "workspaces", "root-chat"),
          linked_workspace: true,
          root_parent_chat_id: "root-chat",
        },
      },
    }),
  );
  const previousCfgDir = process.env.PORTICO_WORKSPACE_CFG_DIR;
  process.env.PORTICO_WORKSPACE_CFG_DIR = cfgDir;
  try {
    const mkdirCalls = [];
    const workspace = await ensureChatWorkspaceDirectories({
      projectRoot: tempRoot,
      chatId: "child-chat",
      mkdir: async (target, options) => {
        mkdirCalls.push([target, options]);
      },
    });

    assert.equal(workspace.linkedWorkspace, true);
    assert.equal(
      workspace.chatWorkspace,
      path.resolve(path.join(tempRoot, "workspaces", "root-chat")),
    );
    assert.ok(
      mkdirCalls.some(([target]) => target === workspace.chatWorkspace),
      "expected mkdir for the shared generated dir",
    );
  } finally {
    if (previousCfgDir === undefined) {
      delete process.env.PORTICO_WORKSPACE_CFG_DIR;
    } else {
      process.env.PORTICO_WORKSPACE_CFG_DIR = previousCfgDir;
    }
    fsNative.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("refreshLinkedChatWorkspaceSnapshots rewrites only children linked to the root", async () => {
  const { refreshLinkedChatWorkspaceSnapshots } = require("./chat-workspaces");
  const stored = JSON.stringify({
    chats: {
      "root-chat": { source: "custom", host_path: "/tmp/new-root-dir" },
      "child-a": {
        source: "custom",
        host_path: "/tmp/old-dir",
        linked_workspace: true,
        root_parent_chat_id: "root-chat",
      },
      "child-other-root": {
        source: "custom",
        host_path: "/tmp/old-dir",
        linked_workspace: true,
        root_parent_chat_id: "another-root",
      },
      "plain-inherited": {
        source: "custom",
        host_path: "/tmp/old-dir",
        inherited_workspace: true,
        root_parent_chat_id: "root-chat",
      },
    },
  });

  let written = null;
  const refreshed = await refreshLinkedChatWorkspaceSnapshots({
    projectRoot: "/tmp/project-root",
    rootChatId: "root-chat",
    env: {},
    now: () => new Date("2026-08-05T12:00:00.000Z"),
    existsSync: () => true,
    readFileSync: () => stored,
    mkdir: async () => {},
    writeFile: async (_target, data) => {
      written = JSON.parse(data);
    },
  });

  assert.deepEqual(refreshed, [
    { chatId: "child-a", hostPath: path.resolve("/tmp/new-root-dir") },
  ]);
  assert.equal(written.chats["child-a"].host_path, path.resolve("/tmp/new-root-dir"));
  assert.equal(written.chats["child-a"].linked_workspace, true);
  assert.equal(written.chats["child-a"].selected_at, "2026-08-05T12:00:00.000Z");
  assert.equal(written.chats["child-other-root"].host_path, "/tmp/old-dir");
  assert.equal(written.chats["plain-inherited"].host_path, "/tmp/old-dir");
});
