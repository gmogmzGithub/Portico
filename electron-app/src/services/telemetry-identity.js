// Shared, non-interactive identity resolution for adoption telemetry.
// Prefer the authenticated PORTICO session, then the Portico environment identity,
// then the local OS account. Resolution is cached and never throws.

const os = require("os");

const CACHE_TTL_MS = 5 * 60 * 1000;

let cached = null;
let cachedAt = 0;

function ldapFromIdentityValue(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return "";
  }
  const atIndex = trimmed.indexOf("@");
  return atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
}

async function resolveTelemetryIdentityUncached(options = {}) {
  const getCurrentUser = options.getCurrentUser || (() => require("./current-user").get());
  try {
    const result = await getCurrentUser();
    const ldap = ldapFromIdentityValue(result?.sessionSummary?.user?.id);
    if (result?.authenticated && ldap) {
      return { ldap, identitySource: "okta_cached" };
    }
  } catch (error) {
    if (options.logWarnings !== false) {
      console.warn(
        "[Telemetry] Identity: cached session unavailable:",
        error?.message || error,
      );
    }
  }

  const env = options.env || process.env;
  const envLdap = ldapFromIdentityValue(env.PORTICO_USER_ID || env.portico_LDAP);
  if (envLdap) {
    return { ldap: envLdap, identitySource: "env" };
  }

  try {
    const userInfo = options.userInfo || (() => os.userInfo());
    const ldap = ldapFromIdentityValue(userInfo().username);
    return { ldap: ldap || "anonymous", identitySource: "os_username" };
  } catch (_) {
    return { ldap: "anonymous", identitySource: "os_username" };
  }
}

async function getTelemetryIdentity(options = {}) {
  const now = Date.now();
  if (
    !options.refresh &&
    cached &&
    (now - cachedAt < CACHE_TTL_MS || cached.identitySource === "okta_cached")
  ) {
    return cached;
  }
  cached = await resolveTelemetryIdentityUncached(options);
  cachedAt = now;
  return cached;
}

function resetTelemetryIdentityCacheForTests() {
  cached = null;
  cachedAt = 0;
}

module.exports = {
  getTelemetryIdentity,
  ldapFromIdentityValue,
  resetTelemetryIdentityCacheForTests,
  resolveTelemetryIdentityUncached,
};
