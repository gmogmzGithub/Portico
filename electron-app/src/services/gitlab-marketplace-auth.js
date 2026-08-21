const { app, safeStorage, shell } = require("electron");
const fs = require("fs");
const fsPromises = require("fs").promises;
const http = require("http");
const path = require("path");
const {
  GITLAB_MARKETPLACE_AUTH_CONFIG,
  getAcceptedGitlabMarketplaceAuthRedirectUris,
  getGitlabMarketplaceAuthRedirectUri,
} = require("../config/gitlab-marketplace-auth-config");
const {
  buildAuthorizeUrl,
  buildSessionRecord,
  buildSessionSummary,
  classifyCallbackRequest,
  createPkcePair,
  createSetupAuthError,
  createStateToken,
  decodeJwtClaims,
  decryptSessionRecord,
  encryptSessionRecord,
  isSessionExpired,
  needsUserInfo,
  resolvePorticoUserClaims,
  selectCanonicalEmail,
  sessionFallbackClaims,
} = require("./setup-auth-shared");
const { openHttpExternalUrl } = require("./shell-open");

function buildCallbackPage({
  title,
  heading,
  actionText,
  status = "success",
}) {
  const accent = status === "error" ? "#c62828" : "#003a9b";
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light;
        --page-bg: #cdd4e0;
        --surface: #d7dee7;
        --text: #171717;
        --text-secondary: #525252;
        --text-tertiary: #737373;
        --accent: ${accent};
        --radius-xl: 32px;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        padding: clamp(28px, 5vw, 56px);
        background: var(--page-bg);
        color: var(--text);
        font-family: "Portico Sans", -apple-system, BlinkMacSystemFont, "Avenir Next", "Helvetica Neue", Arial, sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      main {
        width: min(760px, 100%);
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
      }
      .eyebrow {
        margin: 0 0 0.75rem 0;
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--text-tertiary);
      }
      h1 {
        margin: 0 0 1.75rem 0;
        max-width: 10ch;
        font-size: clamp(3rem, 8vw, 5rem);
        line-height: 0.94;
        letter-spacing: -0.06em;
        font-weight: 700;
        color: var(--accent);
        text-wrap: balance;
      }
      section {
        width: min(100%, 34rem);
        padding: 1.6rem;
        border-radius: var(--radius-xl);
        background: var(--surface);
      }
      .card-label {
        margin: 0 0 0.85rem 0;
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--text-tertiary);
      }
      .action-title {
        margin: 0;
        max-width: 13ch;
        margin-left: auto;
        margin-right: auto;
        font-size: 1.9rem;
        line-height: 1.12;
        font-weight: 650;
        color: var(--text);
      }
      .action-copy {
        margin: 0.9rem 0 0;
        font-size: 0.98rem;
        line-height: 1.65;
        color: var(--text-secondary);
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Portico</p>
      <h1>${heading}</h1>
      <section>
        <p class="card-label">Next Step</p>
        <p class="action-title">${actionText}</p>
        <p class="action-copy">Switch back to the app. This browser step is already complete.</p>
      </section>
    </main>
  </body>
</html>`;
}

const SUCCESS_PAGE = buildCallbackPage({
  title: "Portico",
  heading: "GitLab access is ready.",
  actionText: "Return to Portico and continue the marketplace action.",
});

const ERROR_PAGE = buildCallbackPage({
  title: "Portico",
  heading: "GitLab login failed.",
  actionText: "Return to Portico and try the authorization again.",
  status: "error",
});

const defaultHost = GITLAB_MARKETPLACE_AUTH_CONFIG.allowedHosts[0];
const statusByHost = new Map();
const activeLoginPromises = new Map();
// GitLab refresh tokens are SINGLE-USE (rotation): two concurrent refreshes
// with the same stored token make the loser a replay, and GitLab's
// reuse-detection answers replays by revoking the WHOLE token family —
// destroying the session server-side even for the winner. Parallel callers
// (the marketplace freshness sweep fans out pooled fetches) must share one
// in-flight refresh per host.
const activeRefreshPromises = new Map();

function createInitialStatus(host) {
  return {
    host,
    phase: "idle",
    inProgress: false,
    authenticated: false,
    error: null,
    errorCode: null,
    message: null,
    sessionSummary: null,
    updatedAt: Date.now(),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureSupportedHost(host = defaultHost) {
  const normalizedHost = String(host || defaultHost).trim().toLowerCase();
  if (!normalizedHost) {
    throw createSetupAuthError(
      "Missing GitLab host for marketplace authentication",
      "gitlab_host_missing",
    );
  }

  if (!GITLAB_MARKETPLACE_AUTH_CONFIG.allowedHosts.includes(normalizedHost)) {
    throw createSetupAuthError(
      `GitLab host "${normalizedHost}" is not enabled for marketplace authentication`,
      "gitlab_host_unsupported",
    );
  }

  return normalizedHost;
}

function getStatusRecord(host = defaultHost) {
  const normalizedHost = ensureSupportedHost(host);
  if (!statusByHost.has(normalizedHost)) {
    statusByHost.set(normalizedHost, createInitialStatus(normalizedHost));
  }
  return statusByHost.get(normalizedHost);
}

function setStatus(host, patch) {
  const normalizedHost = ensureSupportedHost(host);
  const nextStatus = {
    ...getStatusRecord(normalizedHost),
    ...patch,
    host: normalizedHost,
    updatedAt: Date.now(),
  };
  statusByHost.set(normalizedHost, nextStatus);
  return clone(nextStatus);
}

function getSessionFilePath(host = defaultHost) {
  const normalizedHost = ensureSupportedHost(host);
  const sanitizedHost = normalizedHost.replace(/[^a-z0-9.-]+/gi, "-");
  return path.join(
    app.getPath("userData"),
    `${sanitizedHost}-${GITLAB_MARKETPLACE_AUTH_CONFIG.sessionFileName}`,
  );
}

function ensureSecureStorageAvailable() {
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw createSetupAuthError(
      "Secure token storage is unavailable on this device. GitLab marketplace login cannot continue.",
      "auth_storage_unavailable",
    );
  }

  if (
    process.platform === "linux" &&
    typeof safeStorage.getSelectedStorageBackend === "function" &&
    safeStorage.getSelectedStorageBackend() === "basic_text"
  ) {
    throw createSetupAuthError(
      "Secure token storage is unavailable because Electron safeStorage is using basic_text.",
      "auth_storage_unavailable",
    );
  }
}

async function loadStoredSession(host = defaultHost) {
  ensureSecureStorageAvailable();
  const sessionFilePath = getSessionFilePath(host);
  if (!fs.existsSync(sessionFilePath)) {
    return null;
  }

  const encrypted = await fsPromises.readFile(sessionFilePath);
  try {
    return decryptSessionRecord(encrypted, safeStorage);
  } catch (error) {
    // Undecryptable blob (e.g. keychain access denied to a rebuilt dev
    // binary): treat as signed-out instead of an error state — the next
    // interactive touch re-authenticates. Log it so recurring prompts have
    // a forensic trail.
    console.warn(
      `[gitlab-marketplace-auth] stored session for ${host} could not be decrypted (${error?.message || error}); treating as signed out`,
    );
    return null;
  }
}

async function persistSession(host, session) {
  ensureSecureStorageAvailable();
  const sessionFilePath = getSessionFilePath(host);
  await fsPromises.mkdir(path.dirname(sessionFilePath), { recursive: true });
  await fsPromises.writeFile(
    sessionFilePath,
    encryptSessionRecord(session, safeStorage),
  );
}

async function clearStoredSession(host = defaultHost) {
  const sessionFilePath = getSessionFilePath(host);
  await fsPromises.rm(sessionFilePath, { force: true });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(
      options.timeoutMs || GITLAB_MARKETPLACE_AUTH_CONFIG.networkTimeoutMs,
    ),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createSetupAuthError(
      `${options.errorPrefix || "GitLab OAuth request failed"} (${response.status})`,
      options.errorCode || "oauth_request_failed",
      {
        status: response.status,
        response: data,
      },
    );
  }

  return data;
}

async function discoverMetadata(host = defaultHost) {
  const normalizedHost = ensureSupportedHost(host);
  const baseUrl = GITLAB_MARKETPLACE_AUTH_CONFIG.baseUrl;
  const metadata = await fetchJson(
    `${baseUrl}/.well-known/openid-configuration`,
    {
      errorPrefix: `GitLab discovery failed for ${normalizedHost}`,
      errorCode: "discovery_failed",
    },
  );

  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw createSetupAuthError(
      "GitLab discovery metadata is missing required endpoints",
      "discovery_invalid",
    );
  }

  return metadata;
}

async function postTokenRequest({
  metadata,
  params,
  errorPrefix,
  errorCode,
  allowSecretFallback = true,
}) {
  try {
    return await fetchJson(metadata.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
      errorPrefix,
      errorCode,
    });
  } catch (error) {
    const shouldRetryWithSecret =
      allowSecretFallback &&
      error?.response?.error === "invalid_client" &&
      GITLAB_MARKETPLACE_AUTH_CONFIG.clientSecret;

    if (!shouldRetryWithSecret) {
      throw error;
    }

    return await fetchJson(metadata.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        ...params,
        client_secret: GITLAB_MARKETPLACE_AUTH_CONFIG.clientSecret,
      }),
      errorPrefix,
      errorCode,
    });
  }
}

async function exchangeAuthorizationCode({
  metadata,
  code,
  codeVerifier,
  redirectUri,
}) {
  return await postTokenRequest({
    metadata,
    params: {
      grant_type: "authorization_code",
      client_id: GITLAB_MARKETPLACE_AUTH_CONFIG.clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
    },
    errorPrefix: "GitLab token exchange failed",
    errorCode: "token_exchange_failed",
  });
}

async function fetchUserInfo({ metadata, accessToken }) {
  if (!metadata?.userinfo_endpoint || !accessToken) {
    return {};
  }

  try {
    return await fetchJson(metadata.userinfo_endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      errorPrefix: "GitLab userinfo lookup failed",
      errorCode: "userinfo_failed",
    });
  } catch {
    return {};
  }
}

async function resolveClaims({ tokenResponse, metadata, fallbackClaims = {} }) {
  const idTokenClaims = decodeJwtClaims(tokenResponse.id_token || "");
  // GitLab keeps the id+name-only userinfo-fetch decision (no requireEmail):
  // marketplace viewer identity comes from the Okta session, so an extra
  // GitLab userinfo round-trip per refresh buys nothing.
  if (!needsUserInfo({ ...fallbackClaims, ...idTokenClaims })) {
    const baseline = { ...fallbackClaims, ...idTokenClaims };
    baseline.email = selectCanonicalEmail({ idTokenClaims, fallbackClaims });
    return baseline;
  }

  const userInfo = await fetchUserInfo({
    metadata,
    accessToken: tokenResponse.access_token,
  });
  const merged = {
    ...userInfo,
    ...fallbackClaims,
    ...idTokenClaims,
  };
  merged.email = selectCanonicalEmail({ idTokenClaims, userInfo, fallbackClaims });
  return merged;
}

async function refreshSession(host, session, metadata = null) {
  if (!session?.refreshToken) {
    throw createSetupAuthError(
      "No refresh token is available for the stored GitLab marketplace login",
      "missing_refresh_token",
    );
  }

  const discoveredMetadata = metadata || (await discoverMetadata(host));
  const refreshedTokens = await postTokenRequest({
    metadata: discoveredMetadata,
    params: {
      grant_type: "refresh_token",
      client_id: GITLAB_MARKETPLACE_AUTH_CONFIG.clientId,
      refresh_token: session.refreshToken,
      scope: (session.scopes || GITLAB_MARKETPLACE_AUTH_CONFIG.scopes).join(" "),
    },
    errorPrefix: "GitLab refresh failed",
    errorCode: "refresh_failed",
  });

  const claims = await resolveClaims({
    tokenResponse: refreshedTokens,
    metadata: discoveredMetadata,
    fallbackClaims: sessionFallbackClaims(session),
  });
  const nextSession = buildSessionRecord({
    tokenResponse: {
      ...refreshedTokens,
      refresh_token: refreshedTokens.refresh_token || session.refreshToken,
      id_token: refreshedTokens.id_token || session.idToken,
      scope: refreshedTokens.scope || (session.scopes || []).join(" "),
    },
    metadata: discoveredMetadata,
    config: {
      ...GITLAB_MARKETPLACE_AUTH_CONFIG,
      issuer: GITLAB_MARKETPLACE_AUTH_CONFIG.baseUrl,
      discoveryUrl: `${GITLAB_MARKETPLACE_AUTH_CONFIG.baseUrl}/.well-known/openid-configuration`,
    },
    claims,
    // Retained id_token is storage only; identity comes from tokens minted
    // by THIS refresh response (see setup-auth-shared buildSessionRecord).
    identityIdToken: refreshedTokens.id_token || null,
  });

  await persistSession(host, nextSession);
  console.log(
    `[gitlab-marketplace-auth] session refreshed for ${host} (rotated=${Boolean(
      refreshedTokens.refresh_token && refreshedTokens.refresh_token !== session.refreshToken,
    )})`,
  );
  return nextSession;
}

// Single-flight refresh per host. Re-loads the stored session INSIDE the
// lock: a caller that queued behind a completed refresh must use the rotated
// session, never replay the stale token it loaded before queueing.
function refreshSessionShared(host) {
  if (activeRefreshPromises.has(host)) {
    return activeRefreshPromises.get(host);
  }
  const refreshPromise = (async () => {
    const stored = await loadStoredSession(host);
    if (!stored) {
      throw createSetupAuthError(
        `The stored GitLab session for ${host} disappeared before it could be refreshed`,
        "session_missing",
      );
    }
    if (
      !isSessionExpired(stored, {
        skewMs: GITLAB_MARKETPLACE_AUTH_CONFIG.tokenExpirySkewMs,
      })
    ) {
      return stored; // a queued-behind caller: the refresh already happened
    }
    return await refreshSession(host, stored);
  })().finally(() => {
    activeRefreshPromises.delete(host);
  });
  activeRefreshPromises.set(host, refreshPromise);
  return refreshPromise;
}

function writeHtmlResponse(response, statusCode, html) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(html);
}

async function waitForAuthorizationCallback({
  expectedState,
  expectedRedirectUri,
  acceptedRedirectUris = [],
}) {
  return await new Promise((resolve, reject) => {
    const redirectUrl = new URL(expectedRedirectUri);
    let settled = false;

    const server = http.createServer((request, response) => {
      const requestOrigin = `http://${request.headers.host || redirectUrl.host}`;
      const requestUrl = new URL(request.url || "/", requestOrigin);

      const result = classifyCallbackRequest({
        requestUrl: requestUrl.toString(),
        expectedState,
        expectedRedirectUri,
        acceptedRedirectUris,
      });

      if (result.type === "success") {
        writeHtmlResponse(response, 200, SUCCESS_PAGE);
        settled = true;
        cleanup();
        resolve(result);
        return;
      }

      if (result.type === "error") {
        writeHtmlResponse(response, 400, ERROR_PAGE);
        settled = true;
        cleanup();
        reject(result.error);
        return;
      }

      writeHtmlResponse(response, 400, ERROR_PAGE);
      console.warn(
        `[gitlab-marketplace-auth] Ignoring callback request (${result.error.code}): ${requestUrl.toString()}`,
      );
    });

    server.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        createSetupAuthError(
          `Failed to listen for the GitLab callback on ${redirectUrl.host}: ${error.message}`,
          "callback_listener_failed",
        ),
      );
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        createSetupAuthError(
          "Timed out waiting for GitLab marketplace login to finish",
          "auth_timeout",
        ),
      );
    }, GITLAB_MARKETPLACE_AUTH_CONFIG.authTimeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      server.close(() => {});
    }

    server.listen(redirectUrl.port, redirectUrl.hostname, () => undefined);
  });
}

function normalizeError(error) {
  const code =
    typeof error?.code === "string" && error.code
      ? error.code
      : "gitlab_marketplace_auth_failed";
  const message =
    typeof error?.message === "string" && error.message
      ? error.message
      : "GitLab marketplace login failed";

  return { code, message };
}

async function getCachedSession(host = defaultHost) {
  const normalizedHost = ensureSupportedHost(host);
  setStatus(normalizedHost, {
    phase: "checking-session",
    inProgress: false,
    error: null,
    errorCode: null,
    message: null,
  });

  try {
    const existingSession = await loadStoredSession(normalizedHost);
    if (!existingSession) {
      setStatus(normalizedHost, {
        phase: "idle",
        authenticated: false,
        sessionSummary: null,
      });
      return { authenticated: false, session: null, sessionSummary: null };
    }

    if (!isSessionExpired(existingSession, { skewMs: GITLAB_MARKETPLACE_AUTH_CONFIG.tokenExpirySkewMs })) {
      const sessionSummary = buildSessionSummary(existingSession);
      setStatus(normalizedHost, {
        phase: "authenticated",
        authenticated: true,
        sessionSummary,
      });
      return {
        authenticated: true,
        session: existingSession,
        sessionSummary,
        source: "cache",
      };
    }

    if (existingSession.refreshToken) {
      try {
        const refreshedSession = await refreshSessionShared(normalizedHost);
        const sessionSummary = buildSessionSummary(refreshedSession);
        setStatus(normalizedHost, {
          phase: "authenticated",
          authenticated: true,
          sessionSummary,
        });
        return {
          authenticated: true,
          session: refreshedSession,
          sessionSummary,
          source: "refresh",
        };
      } catch (error) {
        // A refresh failure only invalidates the session it actually tried
        // to refresh. If another flow persisted rotated tokens meanwhile,
        // wiping them would finish the job the failed replay started.
        const storedNow = await loadStoredSession(normalizedHost).catch(() => null);
        const cleared =
          !storedNow || storedNow.refreshToken === existingSession.refreshToken;
        if (cleared) {
          await clearStoredSession(normalizedHost);
        }
        console.warn(
          `[gitlab-marketplace-auth] session refresh failed for ${normalizedHost} (${
            normalizeError(error).code
          }); stored session ${cleared ? "cleared" : "left intact (rotated by another flow)"}`,
        );
        setStatus(normalizedHost, {
          phase: "idle",
          authenticated: false,
          sessionSummary: null,
        });
        return {
          authenticated: false,
          session: null,
          sessionSummary: null,
          source: "refresh_failed",
          refreshError: normalizeError(error),
        };
      }
    }

    await clearStoredSession(normalizedHost);
    setStatus(normalizedHost, {
      phase: "idle",
      authenticated: false,
      sessionSummary: null,
    });
    return { authenticated: false, session: null, sessionSummary: null, source: "expired" };
  } catch (error) {
    const normalized = normalizeError(error);
    setStatus(normalizedHost, {
      phase: "error",
      authenticated: false,
      error: normalized.message,
      errorCode: normalized.code,
      sessionSummary: null,
    });
    return {
      authenticated: false,
      session: null,
      sessionSummary: null,
      error: normalized.message,
      errorCode: normalized.code,
    };
  }
}

async function ensureAuthenticated(host = defaultHost) {
  const normalizedHost = ensureSupportedHost(host);
  if (activeLoginPromises.has(normalizedHost)) {
    return await activeLoginPromises.get(normalizedHost);
  }

  const loginPromise = (async () => {
    const cached = await getCachedSession(normalizedHost);
    if (cached.authenticated) {
      return {
        success: true,
        authenticated: true,
        session: cached.session,
        sessionSummary: cached.sessionSummary,
        source: cached.source,
      };
    }

    console.log(
      `[gitlab-marketplace-auth] interactive login required for ${normalizedHost} (reason=${
        cached.source || cached.errorCode || "no_session"
      })`,
    );
    ensureSecureStorageAvailable();

    const metadata = await discoverMetadata(normalizedHost);
    const redirectUri = getGitlabMarketplaceAuthRedirectUri();
    const { codeVerifier, codeChallenge } = createPkcePair();
    const state = createStateToken();
    const authorizationUrl = buildAuthorizeUrl({
      authorizationEndpoint: metadata.authorization_endpoint,
      clientId: GITLAB_MARKETPLACE_AUTH_CONFIG.clientId,
      redirectUri,
      scopes: GITLAB_MARKETPLACE_AUTH_CONFIG.scopes,
      state,
      codeChallenge,
    });

    setStatus(normalizedHost, {
      phase: "opening-browser",
      inProgress: true,
      authenticated: false,
      error: null,
      errorCode: null,
      message: "Opening GitLab in your browser...",
      sessionSummary: null,
    });

    const callbackPromise = waitForAuthorizationCallback({
      expectedState: state,
      expectedRedirectUri: redirectUri,
      acceptedRedirectUris: getAcceptedGitlabMarketplaceAuthRedirectUris(),
    });

    await openHttpExternalUrl(shell, authorizationUrl);

    setStatus(normalizedHost, {
      phase: "waiting-callback",
      inProgress: true,
      message: "Waiting for GitLab to finish...",
    });

    const callbackResult = await callbackPromise;

    setStatus(normalizedHost, {
      phase: "exchanging-token",
      inProgress: true,
      message: "Finishing GitLab sign-in...",
    });

    const tokenResponse = await exchangeAuthorizationCode({
      metadata,
      code: callbackResult.code,
      codeVerifier,
      redirectUri,
    });

    const claims = await resolveClaims({
      tokenResponse,
      metadata,
    });
    const session = buildSessionRecord({
      tokenResponse,
      metadata,
      config: {
        ...GITLAB_MARKETPLACE_AUTH_CONFIG,
        issuer: GITLAB_MARKETPLACE_AUTH_CONFIG.baseUrl,
        discoveryUrl: `${GITLAB_MARKETPLACE_AUTH_CONFIG.baseUrl}/.well-known/openid-configuration`,
      },
      claims,
    });

    if (!session.user?.id || !session.user?.name) {
      session.user = resolvePorticoUserClaims(claims);
    }

    await persistSession(normalizedHost, session);

    const sessionSummary = buildSessionSummary(session);
    setStatus(normalizedHost, {
      phase: "authenticated",
      inProgress: false,
      authenticated: true,
      error: null,
      errorCode: null,
      message: null,
      sessionSummary,
    });

    return {
      success: true,
      authenticated: true,
      session,
      sessionSummary,
      source: "interactive",
    };
  })()
    .catch((error) => {
      const normalized = normalizeError(error);
      setStatus(normalizedHost, {
        phase: "error",
        inProgress: false,
        authenticated: false,
        error: normalized.message,
        errorCode: normalized.code,
        message: null,
        sessionSummary: null,
      });
      return {
        success: false,
        authenticated: false,
        session: null,
        error: normalized.message,
        errorCode: normalized.code,
      };
    })
    .finally(() => {
      activeLoginPromises.delete(normalizedHost);
    });

  activeLoginPromises.set(normalizedHost, loginPromise);
  return await loginPromise;
}

function clearError(host = defaultHost) {
  const normalizedHost = ensureSupportedHost(host);
  const currentStatus = getStatusRecord(normalizedHost);
  if (!currentStatus.error && !currentStatus.errorCode) {
    return clone(currentStatus);
  }

  return setStatus(normalizedHost, {
    phase: currentStatus.authenticated ? "authenticated" : "idle",
    error: null,
    errorCode: null,
    message: null,
  });
}

function getStatus(host = defaultHost) {
  return clone(getStatusRecord(host));
}

async function getCachedSessionSummary(host = defaultHost) {
  const result = await getCachedSession(host);
  return {
    authenticated: result.authenticated,
    sessionSummary: result.sessionSummary,
    source: result.source,
    refreshError: result.refreshError,
    error: result.error,
    errorCode: result.errorCode,
  };
}

async function getAuthorizedSession({ host = defaultHost, interactive = false } = {}) {
  const result = interactive
    ? await ensureAuthenticated(host)
    : await getCachedSession(host);

  if (!result.authenticated || !result.session?.accessToken) {
    throw createSetupAuthError(
      result.error ||
        `GitLab marketplace authentication is required for ${ensureSupportedHost(host)}`,
      result.errorCode || "gitlab_auth_required",
      {
        host: ensureSupportedHost(host),
        authResult: {
          authenticated: result.authenticated,
          error: result.error,
          errorCode: result.errorCode,
          source: result.source,
        },
      },
    );
  }

  return result.session;
}

module.exports = {
  clearError,
  ensureAuthenticated,
  getAuthorizedSession,
  getCachedSessionSummary,
  getStatus,
};
