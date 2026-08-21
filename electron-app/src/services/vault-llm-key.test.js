const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractSecretValue,
  fetchPorticoLlmApiKeyFromVault,
  isMalformedUpstreamKey,
  runVaultLlmPreflight,
} = require("./vault-llm-key");

function createJsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

test("extractSecretValue reads data.data.<field>", () => {
  const payload = {
    data: {
      data: {
        data: "sk-portico-0001",
      },
    },
  };
  assert.equal(extractSecretValue(payload, "data"), "sk-portico-0001");
});

test("isMalformedUpstreamKey rejects empty, placeholder, and JWT-like values", () => {
  assert.equal(isMalformedUpstreamKey(""), true);
  assert.equal(isMalformedUpstreamKey("your-token-here"), true);
  assert.equal(
    isMalformedUpstreamKey("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.signature"),
    true,
  );
  assert.equal(isMalformedUpstreamKey("sk-portico-0001"), false);
});

test("fetchPorticoLlmApiKeyFromVault authenticates and reads configured secret field", async () => {
  const calls = [];
  const result = await fetchPorticoLlmApiKeyFromVault({
    idToken: "id-token-value",
    env: {
      VAULT_ADDR: "https://vault.example.invalid",
      PORTICO_VAULT_SECRET_FIELD: "data",
      PORTICO_VAULT_JWT_ROLES: "portico-desktop",
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes("/auth/jwt/login")) {
        return createJsonResponse({
          auth: { client_token: "vault-client-token" },
        });
      }
      if (url.includes("/secret-units/data/qa/secrets/portico-llm-api-key")) {
        return createJsonResponse({
          data: {
            data: {
              data: "sk-portico-0001",
            },
          },
        });
      }
      return createJsonResponse({}, 404);
    },
  });

  assert.equal(result.key, "sk-portico-0001");
  assert.equal(result.role, "portico-desktop");
  assert.equal(calls.length >= 2, true);
});

test("fetchPorticoLlmApiKeyFromVault tries fallback role after first role fails", async () => {
  const roleCalls = [];
  const result = await fetchPorticoLlmApiKeyFromVault({
    idToken: "id-token-value",
    env: {
      VAULT_ADDR: "https://vault.example.invalid",
      PORTICO_VAULT_SECRET_FIELD: "data",
      PORTICO_VAULT_JWT_ROLES: "portico-desktop,portico-qa",
    },
    fetchImpl: async (url, options = {}) => {
      if (url.includes("/auth/jwt/login")) {
        const body = JSON.parse(options.body);
        roleCalls.push(body.role);
        if (body.role === "portico-desktop") {
          return createJsonResponse({ errors: ["permission denied"] }, 403);
        }
        return createJsonResponse({
          auth: { client_token: "vault-client-token" },
        });
      }
      if (url.includes("/secret-units/data/qa/secrets/portico-llm-api-key")) {
        return createJsonResponse({
          data: {
            data: {
              data: "sk-portico-0002",
            },
          },
        });
      }
      return createJsonResponse({}, 404);
    },
  });

  assert.deepEqual(roleCalls, [
    "portico-desktop",
    "portico-qa",
  ]);
  assert.equal(result.key, "sk-portico-0002");
  assert.equal(result.role, "portico-qa");
});

test("runVaultLlmPreflight reports reachable health and auth failure details", async () => {
  const preflight = await runVaultLlmPreflight({
    idToken: "",
    env: {
      VAULT_ADDR: "https://vault.example.invalid",
    },
    fetchImpl: async (url) => {
      if (url.includes("/v1/sys/health")) {
        return createJsonResponse({}, 200);
      }
      return createJsonResponse({}, 404);
    },
  });

  assert.equal(preflight.health.reachable, true);
  assert.equal(preflight.success, false);
  assert.equal(preflight.errorCode, "vault_missing_id_token");
});
