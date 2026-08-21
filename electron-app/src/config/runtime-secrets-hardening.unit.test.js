const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  RUNTIME_SECRET_ENV_FILE_KEYS,
  buildRuntimeSecretEnv,
  listCloudsmithSecretCandidatePaths,
  listRuntimeSecretCandidatePaths,
  listUpstreamSecretCandidatePaths,
  parseEnvFile,
  isMalformedPorticoLlmApiKey,
  resolvePorticoLlmApiKey,
  shouldAutoScrubAfterKeychain,
} = require("./runtime-secrets-config");

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function withTempRoots(run) {
  const managedRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "runtime-secrets-hardening-managed-"),
  );
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "runtime-secrets-hardening-project-"),
  );
  try {
    return run({ managedRoot, projectRoot });
  } finally {
    fs.rmSync(managedRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function loadCloudsmithConfig(overrides) {
  const previousEnv = process.env;
  process.env = { ...previousEnv, ...overrides };
  try {
    const modulePath = require.resolve("./cloudsmith-config");
    delete require.cache[modulePath];
    return require("./cloudsmith-config");
  } finally {
    process.env = previousEnv;
  }
}

test("RUNTIME_SECRET_ENV_FILE_KEYS covers aliases and _FILE variants", () => {
  const keys = new Set(RUNTIME_SECRET_ENV_FILE_KEYS);
  for (const required of [
    "PORTICO_LLM_API_KEY",
    "AI_MARKETPLACE_API_KEY",
    "LOCAL_STACK_API_KEY",
    "BIFROST_BRIDGE_LOCAL_API_KEY",
    "ULTRA_MULTI_AGENT_SIGNING_SECRET",
    "OWUI_AUTH_BRIDGE_SECRET",
    "WEBUI_SECRET_KEY",
    "CLOUDSMITH_ENTITLEMENT_TOKEN",
    "PORTICO_LLM_API_KEY_FILE",
    "BIFROST_BRIDGE_LOCAL_API_KEY_FILE",
    "ULTRA_MULTI_AGENT_SIGNING_SECRET_FILE",
    "OWUI_AUTH_BRIDGE_SECRET_FILE",
    "WEBUI_SECRET_KEY_FILE",
  ]) {
    assert.equal(
      keys.has(required),
      true,
      `RUNTIME_SECRET_ENV_FILE_KEYS must include ${required}`,
    );
  }
  assert.equal(
    keys.has("CLOUDSMITH_API_KEY"),
    false,
    "the release-operator Cloudsmith key has a dedicated verified managed-bootstrap lifecycle",
  );
});

test("listRuntimeSecretCandidatePaths excludes project root", () => {
  withTempRoots(({ managedRoot, projectRoot }) => {
    const paths = listRuntimeSecretCandidatePaths({
      projectRoot,
      managedRoot,
      resourcesPath: "",
      env: {},
    });
    for (const candidate of paths) {
      assert.notEqual(
        path.resolve(candidate),
        path.resolve(path.join(projectRoot, "runtime-secrets.env")),
      );
    }
    assert.equal(
      paths.some(
        (candidate) =>
          path.resolve(candidate) ===
          path.resolve(path.join(managedRoot, "runtime-secrets.env")),
      ),
      true,
      "managed root runtime-secrets.env must remain a candidate",
    );
  });
});

test("listUpstreamSecretCandidatePaths excludes project root cloudsmith.env", () => {
  withTempRoots(({ managedRoot, projectRoot }) => {
    const paths = listUpstreamSecretCandidatePaths({
      projectRoot,
      managedRoot,
      resourcesPath: "",
      env: {},
    });
    for (const candidate of paths) {
      assert.notEqual(
        path.resolve(candidate),
        path.resolve(path.join(projectRoot, "cloudsmith.env")),
      );
      assert.notEqual(
        path.resolve(candidate),
        path.resolve(path.join(projectRoot, "runtime-secrets.env")),
      );
    }
  });
});

test("listCloudsmithSecretCandidatePaths excludes project root cloudsmith.env", () => {
  withTempRoots(({ managedRoot, projectRoot }) => {
    const paths = listCloudsmithSecretCandidatePaths({
      projectRoot,
      managedRoot,
      resourcesPath: "",
      env: {},
    });
    for (const candidate of paths) {
      assert.notEqual(
        path.resolve(candidate),
        path.resolve(path.join(projectRoot, "cloudsmith.env")),
      );
    }
  });
});

test("resolvePorticoLlmApiKey ignores project root runtime-secrets.env", () => {
  withTempRoots(({ managedRoot, projectRoot }) => {
    fs.writeFileSync(
      path.join(projectRoot, "runtime-secrets.env"),
      'PORTICO_LLM_API_KEY="portico-live-project-plaintext-1234"\n',
      "utf8",
    );

    const resolved = resolvePorticoLlmApiKey({
      env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
      managedRoot,
      projectRoot,
      resourcesPath: "",
    });

    assert.notEqual(resolved, "portico-live-project-plaintext-1234");
  });
});

test("resolvePorticoLlmApiKey does not ship a bundled legacy credential", () => {
  withTempRoots(({ managedRoot, projectRoot }) => {
    const resolved = resolvePorticoLlmApiKey({
      env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
      managedRoot,
      projectRoot,
      resourcesPath: "",
    });

    assert.equal(resolved, "");
  });
});

test("isMalformedPorticoLlmApiKey rejects very short upstream keys", () => {
  assert.equal(isMalformedPorticoLlmApiKey("ab"), true);
  assert.equal(isMalformedPorticoLlmApiKey("from-env"), false);
});

test("shouldAutoScrubAfterKeychain only fires on packaged macOS without plaintext opt-in", () => {
  assert.equal(
    shouldAutoScrubAfterKeychain({
      env: {},
      platform: "darwin",
      isPackagedApp: true,
    }),
    true,
  );
  assert.equal(
    shouldAutoScrubAfterKeychain({
      env: {},
      platform: "linux",
      isPackagedApp: true,
    }),
    false,
    "non-darwin packaged builds do not auto-scrub (Keychain is darwin-only)",
  );
  assert.equal(
    shouldAutoScrubAfterKeychain({
      env: {},
      platform: "darwin",
      isPackagedApp: false,
    }),
    false,
    "unpackaged dev workflows keep plaintext fallback",
  );
  assert.equal(
    shouldAutoScrubAfterKeychain({
      env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
      platform: "darwin",
      isPackagedApp: true,
    }),
    false,
    "explicit keychain disable preserves plaintext",
  );
  assert.equal(
    shouldAutoScrubAfterKeychain({
      env: { PORTICO_RUNTIME_ALLOW_PLAINTEXT_FALLBACK: "1" },
      platform: "darwin",
      isPackagedApp: true,
    }),
    false,
    "explicit plaintext opt-in preserves plaintext",
  );
});

test("buildRuntimeSecretEnv leaves project .env alone on unpackaged linux builds", () => {
  withTempRoots(({ managedRoot, projectRoot }) => {
    const projectEnvPath = path.join(projectRoot, ".env");
    fs.writeFileSync(
      projectEnvPath,
      'PORTICO_LLM_API_KEY="portico-live-token-1234567890abcd"\n',
      "utf8",
    );

    buildRuntimeSecretEnv({
      env: {
        PORTICO_LLM_API_KEY: "portico-live-token-1234567890abcd",
        PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
      },
      managedRoot,
      projectRoot,
      resourcesPath: "",
      isPackagedApp: false,
      platform: "linux",
    });

    const projectEnv = parseEnvFile(projectEnvPath);
    assert.equal(
      projectEnv.PORTICO_LLM_API_KEY,
      "portico-live-token-1234567890abcd",
      "dev workflows must preserve the project .env file",
    );
  });
});

test("cloudsmith-config exposes CLOUDSMITH_API_KEY for updater discovery", () => {
  const config = loadCloudsmithConfig({
    PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
    CLOUDSMITH_API_KEY: "dev-upload-token",
    CLOUDSMITH_ENTITLEMENT_TOKEN: "runtime-read-token",
    PORTICO_ALLOW_RUNTIME_CLOUDSMITH_API_KEY: "1",
  });
  assert.equal(config.CLOUDSMITH_API_KEY, "dev-upload-token");
  assert.equal(config.CLOUDSMITH_READ_TOKEN, "dev-upload-token");
  assert.equal(config.CLOUDSMITH_ENTITLEMENT_TOKEN, "runtime-read-token");
});
