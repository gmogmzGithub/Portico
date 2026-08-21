const test = require("node:test");
const assert = require("node:assert/strict");

const {
  clearKeychainCache,
  readPorticoLlmApiKeyFromKeychainSync,
  upsertPorticoLlmApiKeyInKeychainSync,
} = require("./llm-keychain");

test("readPorticoLlmApiKeyFromKeychainSync returns empty on non-darwin hosts", () => {
  const value = readPorticoLlmApiKeyFromKeychainSync({
    platform: "linux",
  });
  assert.equal(value, "");
});

test("readPorticoLlmApiKeyFromKeychainSync returns keychain value and caches it", () => {
  clearKeychainCache();
  let calls = 0;
  const readValue = readPorticoLlmApiKeyFromKeychainSync({
    platform: "darwin",
    env: {},
    execFileSyncImpl: () => {
      calls += 1;
      return "sk-portico-0001\n";
    },
  });
  assert.equal(readValue, "sk-portico-0001");
  assert.equal(calls, 1);

  const cached = readPorticoLlmApiKeyFromKeychainSync({
    platform: "darwin",
    env: {},
    execFileSyncImpl: () => {
      calls += 1;
      return "should-not-be-used";
    },
  });
  assert.equal(cached, "sk-portico-0001");
  assert.equal(calls, 1);
});

test("readPorticoLlmApiKeyFromKeychainSync handles missing keychain item", () => {
  clearKeychainCache();
  const missing = readPorticoLlmApiKeyFromKeychainSync({
    platform: "darwin",
    env: {},
    execFileSyncImpl: () => {
      const error = new Error("The specified item could not be found in the keychain");
      error.status = 44;
      throw error;
    },
  });
  assert.equal(missing, "");
});

test("upsertPorticoLlmApiKeyInKeychainSync validates and writes value", () => {
  clearKeychainCache();
  const calls = [];
  const written = upsertPorticoLlmApiKeyInKeychainSync("sk-portico-0002", {
    platform: "darwin",
    env: {},
    execFileSyncImpl: (file, args) => {
      calls.push({ file, args });
      return "";
    },
  });
  assert.equal(written, "sk-portico-0002");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "security");
  assert.deepEqual(calls[0].args.slice(0, 5), [
    "add-generic-password",
    "-U",
    "-s",
    "portico",
    "-a",
  ]);
});

test("keychain helpers support generic metadata accounts and cache by account", () => {
  clearKeychainCache();
  const backing = new Map();
  let findCalls = 0;
  const execFileSyncImpl = (_file, args) => {
    const account = args[args.indexOf("-a") + 1];
    if (args[0] === "add-generic-password") {
      backing.set(account, args[args.indexOf("-w") + 1]);
      return "";
    }
    if (args[0] === "find-generic-password") {
      findCalls += 1;
      return `${backing.get(account) || ""}\n`;
    }
    return "";
  };

  const metadataEnv = {
    PORTICO_LLM_KEYCHAIN_ACCOUNT: "TEST_RUNTIME_SECRET_METADATA",
  };
  const secretEnv = {
    PORTICO_LLM_KEYCHAIN_ACCOUNT: "TEST_RUNTIME_SECRET",
  };

  upsertPorticoLlmApiKeyInKeychainSync('{"owner":"bundled"}', {
    platform: "darwin",
    env: metadataEnv,
    execFileSyncImpl,
  });
  assert.equal(
    readPorticoLlmApiKeyFromKeychainSync({
      platform: "darwin",
      env: metadataEnv,
      execFileSyncImpl,
    }),
    '{"owner":"bundled"}',
  );
  assert.equal(findCalls, 0, "same-account read should use the write cache");

  upsertPorticoLlmApiKeyInKeychainSync("secret-value", {
    platform: "darwin",
    env: secretEnv,
    execFileSyncImpl,
  });
  assert.equal(
    readPorticoLlmApiKeyFromKeychainSync({
      platform: "darwin",
      env: metadataEnv,
      execFileSyncImpl,
    }),
    '{"owner":"bundled"}',
  );
  assert.equal(
    findCalls,
    1,
    "reading a different account after another write should re-query Keychain",
  );
});

test("upsertPorticoLlmApiKeyInKeychainSync rejects empty values", () => {
  assert.throws(
    () =>
      upsertPorticoLlmApiKeyInKeychainSync("   ", {
        platform: "darwin",
        env: {},
        execFileSyncImpl: () => "",
      }),
    /must be a non-empty string/,
  );
});
