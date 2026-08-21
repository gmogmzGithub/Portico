const {
  getVaultLlmConfig,
  isLocalhostVaultAddr,
} = require("../config/vault-llm-config");

const JWT_LIKE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function normalizeSecretValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildVaultError(message, code, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details && typeof details === "object") {
    error.details = details;
  }
  return error;
}

function buildVaultUrl(vaultAddr, routePath) {
  const base = String(vaultAddr || "").replace(/\/+$/, "");
  const route = String(routePath || "").startsWith("/")
    ? routePath
    : `/${routePath}`;
  return `${base}${route}`;
}

function parseVaultResponseBody(body) {
  if (!body || typeof body !== "object") {
    return {};
  }
  return body;
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function probeVaultHealth({
  vaultAddr,
  timeoutMs,
  fetchImpl = fetch,
} = {}) {
  try {
    const healthResponse = await fetchImpl(
      buildVaultUrl(vaultAddr, "/v1/sys/health?standbyok=true&perfstandbyok=true"),
      {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    return {
      reachable: healthResponse.ok,
      statusCode: healthResponse.status,
      statusText: healthResponse.statusText || "",
    };
  } catch (error) {
    return {
      reachable: false,
      statusCode: null,
      statusText: "",
      error: error?.message || "Vault health probe failed",
    };
  }
}

async function vaultJwtLogin({
  vaultAddr,
  jwtLoginPath,
  role,
  idToken,
  timeoutMs,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(buildVaultUrl(vaultAddr, jwtLoginPath), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      role,
      jwt: idToken,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = parseVaultResponseBody(await readJsonResponse(response));
  if (!response.ok) {
    throw buildVaultError(
      `Vault JWT login failed for role ${role} (${response.status})`,
      "vault_jwt_login_failed",
      {
        role,
        status: response.status,
        errors: body?.errors || [],
      },
    );
  }

  const clientToken = normalizeSecretValue(body?.auth?.client_token);
  if (!clientToken) {
    throw buildVaultError(
      `Vault JWT login returned no client token for role ${role}`,
      "vault_jwt_missing_client_token",
      { role },
    );
  }

  return clientToken;
}

async function readVaultSecret({
  vaultAddr,
  secretPath,
  clientToken,
  timeoutMs,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(buildVaultUrl(vaultAddr, secretPath), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Vault-Token": clientToken,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = parseVaultResponseBody(await readJsonResponse(response));
  if (!response.ok) {
    throw buildVaultError(
      `Vault secret read failed (${response.status})`,
      "vault_secret_read_failed",
      {
        status: response.status,
        errors: body?.errors || [],
      },
    );
  }

  return body;
}

function extractSecretValue(payload, secretField) {
  const key = normalizeSecretValue(secretField);
  if (!key) {
    return "";
  }
  return normalizeSecretValue(payload?.data?.data?.[key]);
}

function isMalformedUpstreamKey(value) {
  const normalized = normalizeSecretValue(value);
  if (!normalized) {
    return true;
  }
  if (JWT_LIKE_PATTERN.test(normalized)) {
    return true;
  }
  const lower = normalized.toLowerCase();
  return (
    lower.includes("placeholder") ||
    lower.includes("example") ||
    lower.includes("your_") ||
    lower.includes("your-")
  );
}

async function fetchPorticoLlmApiKeyFromVault({
  idToken,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const config = getVaultLlmConfig({ env });
  const normalizedToken = normalizeSecretValue(idToken);
  if (!normalizedToken) {
    throw buildVaultError(
      "Setup auth session does not contain an id_token required for Vault JWT auth",
      "vault_missing_id_token",
    );
  }

  if (
    isLocalhostVaultAddr(config.vaultAddr) &&
    !config.allowLocalhost
  ) {
    throw buildVaultError(
      `Vault address must not point to localhost in this runtime: ${config.vaultAddr}`,
      "vault_localhost_blocked",
      { vaultAddr: config.vaultAddr },
    );
  }

  const roleErrors = [];
  for (const role of config.jwtRoles) {
    try {
      const clientToken = await vaultJwtLogin({
        vaultAddr: config.vaultAddr,
        jwtLoginPath: config.jwtLoginPath,
        role,
        idToken: normalizedToken,
        timeoutMs: config.timeoutMs,
        fetchImpl,
      });
      const payload = await readVaultSecret({
        vaultAddr: config.vaultAddr,
        secretPath: config.secretPath,
        clientToken,
        timeoutMs: config.timeoutMs,
        fetchImpl,
      });
      const secretValue = extractSecretValue(payload, config.secretField);
      if (!secretValue) {
        throw buildVaultError(
          `Vault secret payload does not contain field ${config.secretField}`,
          "vault_secret_field_missing",
          {
            secretPath: config.secretPath,
            secretField: config.secretField,
          },
        );
      }
      if (isMalformedUpstreamKey(secretValue)) {
        throw buildVaultError(
          "Vault returned a malformed PORTICO_LLM_API_KEY value",
          "vault_secret_value_invalid",
          {
            secretPath: config.secretPath,
            secretField: config.secretField,
          },
        );
      }

      return {
        key: secretValue,
        role,
        vaultAddr: config.vaultAddr,
        secretPath: config.secretPath,
        secretField: config.secretField,
      };
    } catch (error) {
      roleErrors.push({
        role,
        code: error?.code || "vault_role_attempt_failed",
        message: error?.message || "Vault role attempt failed",
      });
    }
  }

  throw buildVaultError(
    "Vault JWT authentication failed for all configured roles",
    "vault_all_roles_failed",
    {
      roles: config.jwtRoles.slice(),
      attempts: roleErrors,
    },
  );
}

async function runVaultLlmPreflight({
  idToken,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const config = getVaultLlmConfig({ env });
  const health = await probeVaultHealth({
    vaultAddr: config.vaultAddr,
    timeoutMs: config.timeoutMs,
    fetchImpl,
  });

  if (!health.reachable) {
    return {
      success: false,
      health,
      vaultAddr: config.vaultAddr,
      errorCode: "vault_unreachable",
      error:
        health.error ||
        `Vault health probe failed with status ${health.statusCode || "unknown"}`,
    };
  }

  try {
    const fetched = await fetchPorticoLlmApiKeyFromVault({
      idToken,
      env,
      fetchImpl,
    });
    return {
      success: true,
      health,
      ...fetched,
    };
  } catch (error) {
    return {
      success: false,
      health,
      vaultAddr: config.vaultAddr,
      errorCode: error?.code || "vault_preflight_failed",
      error: error?.message || "Vault preflight failed",
      details: error?.details || null,
    };
  }
}

module.exports = {
  buildVaultError,
  extractSecretValue,
  fetchPorticoLlmApiKeyFromVault,
  isMalformedUpstreamKey,
  probeVaultHealth,
  runVaultLlmPreflight,
};
