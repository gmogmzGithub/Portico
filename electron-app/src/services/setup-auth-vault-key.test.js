const test = require("node:test");
const assert = require("node:assert/strict");

const {
  provisionPorticoLlmApiKeyFromSetupAuth,
} = require("./setup-auth-vault-key");

test("provisionPorticoLlmApiKeyFromSetupAuth fetches from Vault and persists to keychain", async () => {
  const secretWrites = [];
  const strippedArgs = [];
  const result = await provisionPorticoLlmApiKeyFromSetupAuth({
    setupAuthService: {
      async getAuthorizedSession() {
        return { idToken: "okta-id-token" };
      },
    },
    preflight: async () => ({
      success: true,
      key: "sk-portico-0001",
      vaultAddr: "https://vault.example.invalid",
      role: "portico-desktop",
      secretPath:
        "/v1/portico/secret-units/data/qa/secrets/portico-llm-api-key",
      secretField: "data",
    }),
    persistRuntimeSecret: (key, value, options) => {
      secretWrites.push({ key, value, options });
      return value;
    },
    stripLegacyRuntimeFiles: (options) => {
      strippedArgs.push(options);
      return ["/tmp/runtime-secrets.env"];
    },
    projectRoot: "/tmp/project",
    managedRoot: "/tmp/managed",
    resourcesPath: "/tmp/resources",
    env: {},
  });

  assert.equal(secretWrites.length, 1);
  assert.equal(secretWrites[0].key, "PORTICO_LLM_API_KEY");
  assert.equal(secretWrites[0].value, "sk-portico-0001");
  assert.equal(secretWrites[0].options.managedRoot, "/tmp/managed");
  assert.equal(result.success, true);
  assert.equal(result.keySource, "vault");
  assert.equal(result.role, "portico-desktop");
  assert.equal(strippedArgs.length, 1);
});

test("provisionPorticoLlmApiKeyFromSetupAuth surfaces preflight failures", async () => {
  await assert.rejects(
    () =>
      provisionPorticoLlmApiKeyFromSetupAuth({
        setupAuthService: {
          async getAuthorizedSession() {
            return { idToken: "okta-id-token" };
          },
        },
        preflight: async () => ({
          success: false,
          errorCode: "vault_unreachable",
          error: "Vault health probe failed",
          health: { reachable: false, statusCode: null },
        }),
        persistRuntimeSecret: () => "ignored",
        stripLegacyRuntimeFiles: () => [],
        env: {},
      }),
    /Vault health probe failed/,
  );
});
