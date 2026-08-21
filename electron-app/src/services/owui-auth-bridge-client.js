const fs = require("node:fs");
const { buildRuntimeSecretEnv } = require("../config/runtime-secrets-config");
const { normalizePlausibleEmail } = require("./setup-auth-shared");

const OPEN_WEBUI_HOME_URL = "http://localhost:3789";
const OWUI_READY_TIMEOUT_MS = 60_000;
const OWUI_READY_POLL_INTERVAL_MS = 1_000;
const OWUI_REQUEST_TIMEOUT_MS = 10_000;

function getProjectRoot() {
  try {
    const bootstrap = require("./bootstrap");
    return bootstrap.PROJECT_ROOT || process.env.PROJECT_ROOT || process.cwd();
  } catch (_error) {
    return process.env.PROJECT_ROOT || process.cwd();
  }
}

function readFileSecret(filePath) {
  const trimmed = String(filePath || "").trim();
  if (!trimmed) {
    return "";
  }
  try {
    return fs.readFileSync(trimmed, "utf8").trim();
  } catch (_error) {
    return "";
  }
}

function getOwuiAuthBridgeSecret() {
  const direct = String(process.env.OWUI_AUTH_BRIDGE_SECRET || "").trim();
  if (direct) {
    return direct;
  }
  const fromFile = readFileSecret(process.env.OWUI_AUTH_BRIDGE_SECRET_FILE);
  if (fromFile) {
    return fromFile;
  }

  const runtimeSecrets = buildRuntimeSecretEnv({
    env: process.env,
    projectRoot: getProjectRoot(),
    resourcesPath: process.resourcesPath,
    managedRoot: process.env.PORTICO_MANAGED_ROOT || undefined,
  });
  return String(runtimeSecrets.OWUI_AUTH_BRIDGE_SECRET || "").trim();
}

function safeRedirectPath(rawValue = "/") {
  try {
    const parsed = new URL(String(rawValue || "/"), OPEN_WEBUI_HOME_URL);
    if (parsed.origin !== OPEN_WEBUI_HOME_URL) {
      return "/";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  } catch (_error) {
    return "/";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOwuiJson(path, options = {}) {
  const { timeoutMs, ...fetchOptions } = options;
  const response = await fetch(`${OPEN_WEBUI_HOME_URL}${path}`, {
    ...fetchOptions,
    signal: AbortSignal.timeout(timeoutMs || OWUI_REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function waitForOwuiReady(options = {}) {
  const timeoutMs = options.timeoutMs || OWUI_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs || OWUI_READY_POLL_INTERVAL_MS;
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const { response } = await fetchOwuiJson("/api/config", {
        method: "GET",
        headers: { Accept: "application/json" },
        timeoutMs: options.requestTimeoutMs || 2_500,
      });
      if (response.ok) {
        return true;
      }
      lastError = new Error(`OWUI readiness check failed (${response.status})`);
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `OWUI did not become ready for authenticated session seeding${lastError ? `: ${lastError.message}` : ""}`,
  );
}

function buildHumanSessionPayload(session, { handoff = false, redirect = "/" } = {}) {
  const user = session?.user || {};
  const claims = user.claims && typeof user.claims === "object" ? user.claims : {};
  // Canonical user.email first, validated legacy claims.email fallback second
  // (older persisted records); both must be plausible or seeding fails closed.
  const email = (
    normalizePlausibleEmail(user.email) ||
    normalizePlausibleEmail(claims.email) ||
    ""
  ).toLowerCase();
  if (!email) {
    throw new Error("Okta session does not include an email address for OWUI auth");
  }

  return {
    email,
    name: String(user.name || claims.name || email.split("@")[0] || email).trim(),
    user_id: String(user.id || claims.preferred_username || claims.sub || "").trim() || null,
    preferred_username:
      String(user.preferredUsername || claims.preferred_username || "").trim() || null,
    claims,
    handoff: Boolean(handoff),
    redirect: safeRedirectPath(redirect),
  };
}

async function postHumanSession(session, options = {}) {
  const bridgeSecret = getOwuiAuthBridgeSecret();
  if (!bridgeSecret) {
    throw new Error("OWUI auth bridge secret is unavailable");
  }

  const response = await fetch(`${OPEN_WEBUI_HOME_URL}/api/v1/portico/auth/human/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bridgeSecret}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(buildHumanSessionPayload(session, options)),
    signal: AbortSignal.timeout(options.timeoutMs || 30_000),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OWUI human auth bridge failed (${response.status})`);
  }
  return payload;
}

async function verifyOwuiToken(payload) {
  const token = String(payload?.token || payload?.access_token || "").trim();
  if (!token) {
    throw new Error("OWUI human auth bridge returned no token");
  }
  const { response } = await fetchOwuiJson("/api/v1/auths/", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    timeoutMs: OWUI_REQUEST_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw new Error(`OWUI seeded session verification failed (${response.status})`);
  }
  return true;
}

async function setOwuiTokenCookie(owuiSession, payload) {
  const token = String(payload?.token || payload?.access_token || "").trim();
  if (!token) {
    throw new Error("OWUI human auth bridge returned no token");
  }

  const cookie = {
    url: OPEN_WEBUI_HOME_URL,
    name: "token",
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: false,
  };
  if (Number.isFinite(Number(payload.expires_at))) {
    cookie.expirationDate = Number(payload.expires_at);
  }
  await owuiSession.cookies.set(cookie);
}

module.exports = {
  OPEN_WEBUI_HOME_URL,
  buildHumanSessionPayload,
  getOwuiAuthBridgeSecret,
  postHumanSession,
  safeRedirectPath,
  setOwuiTokenCookie,
  verifyOwuiToken,
  waitForOwuiReady,
};
