const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { build } = require("../electron-app/node_modules/esbuild");

const REPO_ROOT = path.resolve(__dirname, "..");

let tempDir;
let chatCapabilityScope;

const bundleModule = async (entryPath, outFile) => {
  await build({
    entryPoints: [path.join(REPO_ROOT, entryPath)],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: ["node20"],
    logLevel: "silent",
    outfile: outFile,
  });

  return require(outFile);
};

before(async () => {
  tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-capability-scope-tests-"),
  );
  chatCapabilityScope = await bundleModule(
    "src/patches/frontend/src/lib/utils/chatCapabilityScope.ts",
    path.join(tempDir, "chatCapabilityScope.cjs"),
  );
});

after(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("scoped active capability tool ids include same-chat server ids only", () => {
  assert.deepEqual(
    chatCapabilityScope.getScopedActiveCapabilityToolIds({
      activeCapabilities: {
        tools: [
          { server_id: "portico-incident-data" },
          { server_id: "web-tools" },
          { server_id: "server:portico-incident-data" },
          { server_id: "server:server:web-tools" },
          { server_id: "portico-incident-data" },
          { server_id: "   " },
        ],
        skills: [],
      },
      requestChatId: "67ee9c0d-221c-4372-be69-3ed1cb667484",
      activeCapabilitiesChatId: "67ee9c0d-221c-4372-be69-3ed1cb667484",
    }),
    ["server:portico-incident-data", "server:web-tools"],
  );
});

test("scoped active capability tool ids exclude stale previous-chat capabilities", () => {
  assert.deepEqual(
    chatCapabilityScope.getScopedActiveCapabilityToolIds({
      activeCapabilities: {
        tools: [{ server_id: "portico-incident-data" }],
        skills: [],
      },
      requestChatId: "4d207d02-4de3-432c-83c0-7ffe7986f7cf",
      activeCapabilitiesChatId: "67ee9c0d-221c-4372-be69-3ed1cb667484",
    }),
    [],
  );
});

test("active capabilities are ignored when the request chat is still blank", () => {
  assert.equal(
    chatCapabilityScope.shouldUseActiveCapabilitiesForChat({
      requestChatId: "",
      activeCapabilitiesChatId: "67ee9c0d-221c-4372-be69-3ed1cb667484",
    }),
    false,
  );
});
