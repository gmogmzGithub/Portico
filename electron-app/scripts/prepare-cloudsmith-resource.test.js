const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  parseEnvFile,
  readEntitlementTokenFromMacKeychain,
  resolvePackagedCloudsmithEnv,
  validatePackagedCloudsmithEnvFile,
  writePackagedCloudsmithEnv,
} = require("./prepare-cloudsmith-resource");

test("resolvePackagedCloudsmithEnv rejects missing or blank entitlement tokens", () => {
  assert.throws(
    () =>
      resolvePackagedCloudsmithEnv({
        env: { CLOUDSMITH_API_KEY: "api-key" },
        fileValues: {},
      }),
    /CLOUDSMITH_ENTITLEMENT_TOKEN is required for packaged builds/,
  );
  assert.throws(
    () =>
      resolvePackagedCloudsmithEnv({
        env: {
          CLOUDSMITH_API_KEY: "api-key",
          CLOUDSMITH_ENTITLEMENT_TOKEN: "   ",
        },
        fileValues: {},
      }),
    /CLOUDSMITH_ENTITLEMENT_TOKEN is required for packaged builds/,
  );
});

test("resolvePackagedCloudsmithEnv rejects missing or blank API keys", () => {
  assert.throws(
    () =>
      resolvePackagedCloudsmithEnv({
        env: { CLOUDSMITH_ENTITLEMENT_TOKEN: "entitlement-token" },
        fileValues: {},
      }),
    /CLOUDSMITH_API_KEY is required for packaged update discovery/,
  );
  assert.throws(
    () =>
      resolvePackagedCloudsmithEnv({
        env: {
          CLOUDSMITH_API_KEY: "   ",
          CLOUDSMITH_ENTITLEMENT_TOKEN: "entitlement-token",
        },
        fileValues: {},
      }),
    /CLOUDSMITH_API_KEY is required for packaged update discovery/,
  );
});

test("resolvePackagedCloudsmithEnv uses environment, file, then Keychain precedence", () => {
  let keychainReads = 0;
  const readKeychainToken = () => {
    keychainReads += 1;
    return "keychain-token";
  };

  const fromEnvironment = resolvePackagedCloudsmithEnv({
    env: {
      CLOUDSMITH_API_KEY: " environment-api-key ",
      CLOUDSMITH_ENTITLEMENT_TOKEN: " environment-token ",
    },
    fileValues: {
      CLOUDSMITH_API_KEY: "file-api-key",
      CLOUDSMITH_ENTITLEMENT_TOKEN: "file-token",
    },
    readKeychainToken,
  });
  assert.equal(fromEnvironment.CLOUDSMITH_API_KEY, "environment-api-key");
  assert.equal(fromEnvironment.CLOUDSMITH_ENTITLEMENT_TOKEN, "environment-token");
  assert.equal(keychainReads, 0);

  const fromFile = resolvePackagedCloudsmithEnv({
    env: {
      CLOUDSMITH_API_KEY: "   ",
      CLOUDSMITH_ENTITLEMENT_TOKEN: "   ",
    },
    fileValues: {
      CLOUDSMITH_API_KEY: " file-api-key ",
      CLOUDSMITH_ENTITLEMENT_TOKEN: " file-token ",
    },
    readKeychainToken,
  });
  assert.equal(fromFile.CLOUDSMITH_API_KEY, "file-api-key");
  assert.equal(fromFile.CLOUDSMITH_ENTITLEMENT_TOKEN, "file-token");
  assert.equal(keychainReads, 0);

  const fromKeychain = resolvePackagedCloudsmithEnv({
    env: {},
    fileValues: { CLOUDSMITH_API_KEY: "file-api-key" },
    readKeychainToken,
  });
  assert.equal(fromKeychain.CLOUDSMITH_API_KEY, "file-api-key");
  assert.equal(fromKeychain.CLOUDSMITH_ENTITLEMENT_TOKEN, "keychain-token");
  assert.equal(keychainReads, 1);
});

test("readEntitlementTokenFromMacKeychain honors platform and custom coordinates", () => {
  let calls = 0;
  assert.equal(
    readEntitlementTokenFromMacKeychain({
      platform: "linux",
      execFileSyncImpl: () => {
        calls += 1;
        return "must-not-run";
      },
    }),
    "",
  );
  assert.equal(calls, 0);

  const invocations = [];
  const value = readEntitlementTokenFromMacKeychain({
    platform: "darwin",
    env: {
      PORTICO_LLM_KEYCHAIN_SERVICE: "custom-service",
      CLOUDSMITH_ENTITLEMENT_KEYCHAIN_ACCOUNT: "custom-account",
    },
    execFileSyncImpl: (file, args, options) => {
      invocations.push({ file, args, options });
      return " keychain-token\n";
    },
  });
  assert.equal(value, "keychain-token");
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].file, "security");
  assert.deepEqual(invocations[0].args, [
    "find-generic-password",
    "-s",
    "custom-service",
    "-a",
    "custom-account",
    "-w",
  ]);
  assert.deepEqual(invocations[0].options.stdio, ["ignore", "pipe", "pipe"]);
});

test("readEntitlementTokenFromMacKeychain distinguishes missing items from read failures", () => {
  const missing = readEntitlementTokenFromMacKeychain({
    platform: "darwin",
    env: {},
    execFileSyncImpl: () => {
      const error = new Error("The specified item could not be found in the keychain");
      error.status = 44;
      throw error;
    },
  });
  assert.equal(missing, "");

  assert.throws(
    () =>
      readEntitlementTokenFromMacKeychain({
        platform: "darwin",
        env: {},
        execFileSyncImpl: () => {
          const error = new Error("unexpected failure with sensitive-detail");
          error.status = 17;
          error.stderr = "sensitive-stderr";
          throw error;
        },
      }),
    (error) => {
      assert.equal(error.code, "cloudsmith_keychain_read_failed");
      assert.match(error.message, /Set it explicitly or repair Keychain access/);
      assert.doesNotMatch(error.message, /sensitive-detail|sensitive-stderr/);
      return true;
    },
  );
});

test("resolvePackagedCloudsmithEnv preserves API keys with environment precedence", () => {
  const packagedEnv = resolvePackagedCloudsmithEnv({
    env: {
      CLOUDSMITH_OWNER: "portico",
      CLOUDSMITH_REPO: "portico",
      CLOUDSMITH_API_BASE: "https://api.cloudsmith.io/v1",
      CLOUDSMITH_DL_BASE: "https://dl.artifacts.example.invalid",
      CLOUDSMITH_ENTITLEMENT_TOKEN: "read-only-token",
      CLOUDSMITH_API_KEY: "privileged-token",
    },
    fileValues: {
      CLOUDSMITH_API_KEY: "file-api-key",
    },
  });

  assert.equal(packagedEnv.CLOUDSMITH_ENTITLEMENT_TOKEN, "read-only-token");
  assert.equal(packagedEnv.CLOUDSMITH_API_KEY, "privileged-token");
});

test("parseEnvFile reads quoted and unquoted values", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudsmith-env-test-"));
  const envPath = path.join(tempDir, "cloudsmith.env");
  try {
    fs.writeFileSync(
      envPath,
      [
        'CLOUDSMITH_OWNER="portico"',
        "CLOUDSMITH_REPO=portico",
        "",
      ].join("\n"),
      "utf8",
    );

    assert.deepEqual(parseEnvFile(envPath), {
      CLOUDSMITH_OWNER: "portico",
      CLOUDSMITH_REPO: "portico",
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("writePackagedCloudsmithEnv emits packaged resource file", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudsmith-env-write-"));
  const envPath = path.join(tempDir, "cloudsmith.env");
  try {
    writePackagedCloudsmithEnv(
      {
        CLOUDSMITH_OWNER: "portico",
        CLOUDSMITH_REPO: "portico",
        CLOUDSMITH_API_BASE: "https://api.cloudsmith.io/v1",
        CLOUDSMITH_DL_BASE: "https://dl.artifacts.example.invalid",
        CLOUDSMITH_ENTITLEMENT_TOKEN: "read-only-token",
        CLOUDSMITH_API_KEY: "api-key",
      },
      envPath,
    );

    const contents = fs.readFileSync(envPath, "utf8");
    assert.match(contents, /CLOUDSMITH_ENTITLEMENT_TOKEN="read-only-token"/);
    assert.match(contents, /CLOUDSMITH_API_KEY="api-key"/);
    assert.deepEqual(
      fs.readdirSync(tempDir).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("validatePackagedCloudsmithEnvFile requires both credentials and rejects resource drift", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudsmith-env-validate-"));
  const expectedPath = path.join(tempDir, "expected.env");
  const packagedPath = path.join(tempDir, "packaged.env");
  try {
    const expected = {
      CLOUDSMITH_OWNER: "portico",
      CLOUDSMITH_REPO: "portico",
      CLOUDSMITH_API_BASE: "https://api.cloudsmith.io/v1",
      CLOUDSMITH_DL_BASE: "https://dl.artifacts.example.invalid",
      CLOUDSMITH_ENTITLEMENT_TOKEN: "read-only-token",
      CLOUDSMITH_API_KEY: "api-key",
    };
    writePackagedCloudsmithEnv(expected, expectedPath);
    writePackagedCloudsmithEnv(expected, packagedPath);

    assert.doesNotThrow(() =>
      validatePackagedCloudsmithEnvFile(packagedPath, { expectedPath }),
    );

    writePackagedCloudsmithEnv(
      { ...expected, CLOUDSMITH_API_KEY: "different-api-key" },
      packagedPath,
    );
    assert.throws(
      () => validatePackagedCloudsmithEnvFile(packagedPath, { expectedPath }),
      /does not match the prepared release resource for CLOUDSMITH_API_KEY/,
    );

    writePackagedCloudsmithEnv(
      { ...expected, CLOUDSMITH_ENTITLEMENT_TOKEN: "different-read-token" },
      packagedPath,
    );
    assert.throws(
      () => validatePackagedCloudsmithEnvFile(packagedPath, { expectedPath }),
      /does not match the prepared release resource/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
