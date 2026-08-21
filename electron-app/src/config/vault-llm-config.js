const DEFAULT_VAULT_ADDR = "https://vault.example.invalid";
const DEFAULT_VAULT_JWT_LOGIN_PATH = "/v1/auth/jwt/login";
const DEFAULT_VAULT_SECRET_PATH =
  "/v1/portico/secret-units/data/qa/secrets/portico-llm-api-key";
const DEFAULT_VAULT_SECRET_FIELD = "data";
const DEFAULT_VAULT_JWT_ROLES = ["portico-desktop", "portico-qa"];
const DEFAULT_VAULT_REQUEST_TIMEOUT_MS = 10000;

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeVaultAddr(value) {
  const raw = normalizeString(value);
  if (!raw) {
    return "";
  }
  return raw.replace(/\/+$/, "");
}

function normalizePath(value, fallback) {
  const normalized = normalizeString(value) || fallback;
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function splitRoles(rawRoles) {
  if (Array.isArray(rawRoles)) {
    return rawRoles
      .map((role) => normalizeString(role))
      .filter(Boolean);
  }

  const normalized = normalizeString(rawRoles);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
}

function getVaultLlmConfig({ env = process.env } = {}) {
  const configuredRoles = splitRoles(
    env?.PORTICO_VAULT_JWT_ROLES || env?.PORTICO_VAULT_JWT_ROLE,
  );
  const timeoutMs = Number(env?.PORTICO_VAULT_TIMEOUT_MS);

  return {
    vaultAddr: normalizeVaultAddr(env?.VAULT_ADDR) || DEFAULT_VAULT_ADDR,
    jwtLoginPath: normalizePath(
      env?.PORTICO_VAULT_JWT_LOGIN_PATH,
      DEFAULT_VAULT_JWT_LOGIN_PATH,
    ),
    secretPath: normalizePath(
      env?.PORTICO_VAULT_SECRET_PATH,
      DEFAULT_VAULT_SECRET_PATH,
    ),
    secretField:
      normalizeString(env?.PORTICO_VAULT_SECRET_FIELD) ||
      DEFAULT_VAULT_SECRET_FIELD,
    jwtRoles:
      configuredRoles.length > 0
        ? configuredRoles
        : DEFAULT_VAULT_JWT_ROLES.slice(),
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.floor(timeoutMs)
        : DEFAULT_VAULT_REQUEST_TIMEOUT_MS,
    allowLocalhost:
      normalizeString(env?.PORTICO_VAULT_ALLOW_LOCALHOST) === "1",
  };
}

function isLocalhostVaultAddr(vaultAddr) {
  try {
    const parsed = new URL(vaultAddr);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_VAULT_ADDR,
  DEFAULT_VAULT_JWT_LOGIN_PATH,
  DEFAULT_VAULT_JWT_ROLES,
  DEFAULT_VAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_VAULT_SECRET_FIELD,
  DEFAULT_VAULT_SECRET_PATH,
  getVaultLlmConfig,
  isLocalhostVaultAddr,
  normalizeVaultAddr,
};
