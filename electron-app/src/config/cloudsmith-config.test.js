const test = require("node:test");
const assert = require("node:assert/strict");

function withEnv(overrides, run) {
  const previousEnv = process.env;
  process.env = { ...previousEnv, ...overrides };
  try {
    return run();
  } finally {
    process.env = previousEnv;
  }
}

function loadCloudsmithConfig() {
  const modulePath = require.resolve("./cloudsmith-config");
  delete require.cache[modulePath];
  return require("./cloudsmith-config");
}

test("cloudsmith config uses the API key for discovery and entitlement for downloads", () => {
  withEnv(
    {
      PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
      CLOUDSMITH_API_KEY: "dev-upload-token",
      CLOUDSMITH_ENTITLEMENT_TOKEN: "runtime-read-token",
    },
    () => {
      const config = loadCloudsmithConfig();
      assert.equal(config.CLOUDSMITH_ENTITLEMENT_TOKEN, "runtime-read-token");
      assert.equal(config.CLOUDSMITH_READ_TOKEN, "dev-upload-token");
      assert.equal(config.CLOUDSMITH_API_KEY, "dev-upload-token");
    },
  );
});

test("cloudsmith config does not substitute the entitlement token for a missing API key", () => {
  withEnv(
    {
      PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
      CLOUDSMITH_API_KEY: "",
      CLOUDSMITH_ENTITLEMENT_TOKEN: "runtime-read-token",
    },
    () => {
      const config = loadCloudsmithConfig();
      assert.equal(config.CLOUDSMITH_API_KEY, "");
      assert.equal(config.CLOUDSMITH_READ_TOKEN, "");
      assert.equal(config.CLOUDSMITH_ENTITLEMENT_TOKEN, "runtime-read-token");
    },
  );
});
