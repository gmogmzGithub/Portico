const { app, safeStorage, shell } = require('electron');
const fs = require('fs');
const fsPromises = require('fs').promises;
const http = require('http');
const path = require('path');
const {
  SETUP_AUTH_CONFIG,
  getAcceptedSetupAuthRedirectUris,
  getSetupAuthRedirectUri,
} = require('../config/setup-auth-config');
const {
  buildAuthorizeUrl,
  buildSessionRecord,
  buildSessionSummary,
  classifyCallbackRequest,
  createOAuthResponseSummary,
  createPkcePair,
  createSetupAuthError,
  createStateToken,
  decodeJwtClaims,
  decryptSessionRecord,
  encryptSessionRecord,
  isSessionExpired,
  needsUserInfo,
  normalizePlausibleEmail,
  resolvePorticoUserClaims,
  selectCanonicalEmail,
  sessionFallbackClaims,
} = require('./setup-auth-shared');
const { openHttpExternalUrl } = require('./shell-open');
const {
  OPEN_WEBUI_HOME_URL,
  postHumanSession,
  safeRedirectPath,
} = require('./owui-auth-bridge-client');
const { logOAuth } = require('./oauth-logger');

function buildCallbackPage({
  title,
  heading,
  message,
  actionText,
  status = 'success',
  icon = '✓',
}) {
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
        --accent: ${status === 'error' ? '#c62828' : '#003a9b'};
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
      .page {
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
      .header {
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        margin-bottom: 1.75rem;
      }
      h1 {
        margin: 0;
        max-width: 9ch;
        font-size: clamp(3.25rem, 8vw, 5.4rem);
        line-height: 0.94;
        letter-spacing: -0.06em;
        font-weight: 700;
        color: var(--accent);
        text-wrap: balance;
      }
      .action-card {
        background: var(--surface);
        border-radius: var(--radius-xl);
        padding: 1.6rem;
        width: min(100%, 34rem);
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
        max-width: 12ch;
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
      @media (max-width: 860px) {
        body {
          align-items: flex-start;
        }
        h1 {
          max-width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <div class="header">
        <p class="eyebrow">Portico</p>
        <h1>${heading}</h1>
      </div>
      <section class="action-card">
        <p class="card-label">Next Step</p>
        <p class="action-title">${actionText}</p>
        <p class="action-copy">Switch back to the app. This browser step is already complete.</p>
      </section>
    </main>
  </body>
</html>`;
}

const SUCCESS_PAGE = buildCallbackPage({
  title: 'Portico',
  heading: "You're signed in.",
  message: 'The browser handoff finished successfully and setup can keep moving in the app.',
  actionText: 'Return to Portico and continue setup.',
  status: 'success',
  icon: '✓',
});

const ERROR_PAGE = buildCallbackPage({
  title: 'Portico',
  heading: 'Setup login failed.',
  message: 'The browser callback reached the app, but the sign-in flow did not complete cleanly.',
  actionText: 'Return to Portico and try the authorization again.',
  status: 'error',
  icon: '✕',
});

let currentStatus = {
  phase: 'idle',
  inProgress: false,
  authenticated: false,
  error: null,
  errorCode: null,
  message: null,
  sessionSummary: null,
  updatedAt: Date.now(),
};

let activeLoginPromise = null;
let brokerServer = null;
let brokerReadyPromise = null;
const callbackWaiters = new Map();
const browserLoginFlows = new Map();

function cloneStatus() {
  return JSON.parse(JSON.stringify(currentStatus));
}

function setStatus(patch) {
  currentStatus = {
    ...currentStatus,
    ...patch,
    updatedAt: Date.now(),
  };
  return cloneStatus();
}

function getSessionFilePath() {
  return path.join(app.getPath('userData'), SETUP_AUTH_CONFIG.sessionFileName);
}

function ensureSecureStorageAvailable() {
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw createSetupAuthError(
      'Secure token storage is unavailable on this device. Setup login cannot continue.',
      'auth_storage_unavailable',
    );
  }

  if (
    process.platform === 'linux' &&
    typeof safeStorage.getSelectedStorageBackend === 'function' &&
    safeStorage.getSelectedStorageBackend() === 'basic_text'
  ) {
    throw createSetupAuthError(
      'Secure token storage is unavailable because Electron safeStorage is using basic_text.',
      'auth_storage_unavailable',
    );
  }
}

async function loadStoredSession() {
  ensureSecureStorageAvailable();
  const sessionFilePath = getSessionFilePath();
  if (!fs.existsSync(sessionFilePath)) {
    return null;
  }

  let encrypted;
  try {
    encrypted = await fsPromises.readFile(sessionFilePath);
  } catch (error) {
    console.warn(
      `[setup-auth] Stored session unusable (stage=read_failed): ${error.message}`,
    );
    throw createSetupAuthError(
      `Stored setup session could not be read: ${error.message}`,
      'session_read_failed',
      { cause: error },
    );
  }

  try {
    return decryptSessionRecord(encrypted, safeStorage);
  } catch (error) {
    // decryptSessionRecord decrypts then JSON.parses; a SyntaxError means the
    // decrypt succeeded but the payload is corrupted, anything else means the
    // OS-level decrypt itself failed.
    const parseFailed = error instanceof SyntaxError;
    const stage = parseFailed ? 'parse_failed' : 'decrypt_failed';
    const code = parseFailed ? 'session_parse_failed' : 'session_decrypt_failed';
    console.warn(
      `[setup-auth] Stored session unusable (stage=${stage}): ${error.message}. ` +
        'Clearing the stale session file; a rebuilt dev binary losing macOS Keychain ' +
        'access to the Safe Storage key is the most common cause. Setup login will re-run.',
    );
    await clearStoredSession().catch(() => {});
    throw createSetupAuthError(
      `Stored setup session could not be ${parseFailed ? 'parsed' : 'decrypted'}: ${error.message}`,
      code,
      { cause: error },
    );
  }
}

async function persistSession(session) {
  ensureSecureStorageAvailable();
  const sessionFilePath = getSessionFilePath();
  await fsPromises.mkdir(path.dirname(sessionFilePath), { recursive: true });
  await fsPromises.writeFile(
    sessionFilePath,
    encryptSessionRecord(session, safeStorage),
  );
}

async function clearStoredSession() {
  const sessionFilePath = getSessionFilePath();
  await fsPromises.rm(sessionFilePath, { force: true });
}

async function readJsonResponse(response) {
  let rawBody;
  try {
    rawBody = await response.text();
  } catch {
    return { data: {}, bodyKind: 'unparseable' };
  }

  if (!rawBody.trim()) {
    return { data: {}, bodyKind: 'empty' };
  }

  try {
    const data = JSON.parse(rawBody);
    const hasOAuthError =
      data &&
      typeof data === 'object' &&
      (typeof data.error === 'string' ||
        typeof data.error_description === 'string');
    return {
      data,
      bodyKind: hasOAuthError
        ? 'oauth_error_json'
        : 'json_without_oauth_error',
    };
  } catch {
    return { data: {}, bodyKind: 'unparseable' };
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(SETUP_AUTH_CONFIG.networkTimeoutMs),
  });

  const { data, bodyKind } = await readJsonResponse(response);
  if (!response.ok) {
    const responseObject =
      data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const oauthResponseSummary = createOAuthResponseSummary({
      status: response.status,
      bodyKind,
      error: responseObject.error,
      errorDescription: responseObject.error_description,
    });
    throw createSetupAuthError(
      `${options.errorPrefix || 'Setup auth request failed'} (${response.status})`,
      options.errorCode || 'oauth_request_failed',
      {
        status: response.status,
        oauthResponseSummary,
      },
    );
  }

  return data;
}

async function discoverMetadata() {
  const metadata = await fetchJson(SETUP_AUTH_CONFIG.discoveryUrl, {
    errorPrefix: 'Okta discovery failed',
    errorCode: 'discovery_failed',
  });

  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw createSetupAuthError(
      'Okta discovery metadata is missing required endpoints',
      'discovery_invalid',
    );
  }

  return metadata;
}

async function exchangeAuthorizationCode({
  metadata,
  code,
  codeVerifier,
  redirectUri,
}) {
  return await fetchJson(metadata.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: SETUP_AUTH_CONFIG.clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
    }),
    errorPrefix: 'Okta token exchange failed',
    errorCode: 'token_exchange_failed',
  });
}

// Session persists (refresh, identity repair) run one at a time so two
// mutations can never interleave their load→persist windows and roll back a
// rotated refresh token.
let sessionMutationChain = Promise.resolve();
function runExclusiveSessionMutation(task) {
  const run = sessionMutationChain.then(task, task);
  sessionMutationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Set when a fresh interactive sign-in still yielded no email: the IdP simply
// is not providing one, so automatic re-auth attempts must stop (the startup
// gate reads this back as `terminal`). Cleared by any persist that carries a
// plausible email.
let interactiveEmaillessAt = null;

function recordPersistedIdentityState(session, { interactive = false } = {}) {
  if (normalizePlausibleEmail(session?.user?.email)) {
    interactiveEmaillessAt = null;
    return;
  }
  if (interactive) {
    interactiveEmaillessAt = Date.now();
    try {
      logOAuth(
        'Electron',
        'ERROR',
        JSON.stringify({ event: 'setup_auth_email_missing' }),
      );
    } catch {
      // Diagnostics must never break sign-in.
    }
  }
}

async function refreshSession(session, metadata = null) {
  return runExclusiveSessionMutation(() => refreshSessionInner(session, metadata));
}

async function refreshSessionInner(session, metadata = null) {
  if (!session?.refreshToken) {
    throw createSetupAuthError(
      'No refresh token is available for the stored setup login',
      'missing_refresh_token',
    );
  }

  const discoveredMetadata = metadata || (await discoverMetadata());
  const refreshedTokens = await fetchJson(discoveredMetadata.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: SETUP_AUTH_CONFIG.clientId,
      refresh_token: session.refreshToken,
      scope: (session.scopes || SETUP_AUTH_CONFIG.scopes).join(' '),
    }),
    errorPrefix: 'Okta refresh failed',
    errorCode: 'refresh_failed',
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
      scope: refreshedTokens.scope || (session.scopes || []).join(' '),
    },
    metadata: discoveredMetadata,
    claims,
    // The retained id_token above is storage only; identity may come solely
    // from tokens minted by THIS refresh response.
    identityIdToken: refreshedTokens.id_token || null,
  });

  await persistSession(nextSession);
  recordPersistedIdentityState(nextSession);
  return nextSession;
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
      errorPrefix: 'Okta userinfo lookup failed',
      errorCode: 'userinfo_failed',
    });
  } catch (error) {
    // Claim resolution tolerates a userinfo outage, but silently baking an
    // email-less session made PORTICO-414 undiagnosable — leave a fixed-field
    // trace (no message text, no claims).
    try {
      logOAuth(
        'Electron',
        'ERROR',
        JSON.stringify({
          event: 'setup_auth_userinfo_failed',
          failure: typeof error?.code === 'string' ? error.code : 'userinfo_failed',
          httpStatus: Number.isInteger(error?.status) ? error.status : null,
        }),
      );
    } catch {
      // Diagnostics must never break claim resolution.
    }
    return {};
  }
}

async function resolveClaims({ tokenResponse, metadata, fallbackClaims = {} }) {
  const idTokenClaims = decodeJwtClaims(tokenResponse.id_token || '');
  const baseline = { ...fallbackClaims, ...idTokenClaims };
  if (!needsUserInfo(baseline, { requireEmail: true })) {
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
  // Canonical email is chosen explicitly AFTER the spreads so stale fallback
  // or retained-token claims can never clobber a fresher source.
  merged.email = selectCanonicalEmail({ idTokenClaims, userInfo, fallbackClaims });
  return merged;
}

function writeHtmlResponse(response, statusCode, html) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(html);
}

function redirectResponse(response, location) {
  response.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
  });
  response.end();
}

function createBrokerListenerError(error, redirectUrl) {
  if (error?.code === 'EADDRINUSE') {
    return createSetupAuthError(
      `Local Okta callback port ${redirectUrl.port} is already in use. Close the service using it and try again.`,
      'callback_listener_failed',
      { cause: error },
    );
  }

  return createSetupAuthError(
    `Failed to listen for Okta broker on ${redirectUrl.host}: ${error.message}`,
    'callback_listener_failed',
    { cause: error },
  );
}

function settleCallbackWaiter(waiter, result) {
  if (!waiter || waiter.settled) {
    return;
  }
  waiter.settled = true;
  clearTimeout(waiter.timeout);
  callbackWaiters.delete(waiter.expectedState);
  if (result.type === 'success') {
    waiter.resolve(result);
  } else {
    waiter.reject(result.error);
  }
}

async function handleBrowserLoginRequest(requestUrl, response) {
  const metadata = await discoverMetadata();
  const redirectUri = getSetupAuthRedirectUri();
  const { codeVerifier, codeChallenge } = createPkcePair();
  const state = createStateToken();
  const redirect = safeRedirectPath(
    requestUrl.searchParams.get('return_to') ||
      requestUrl.searchParams.get('redirect') ||
      '/',
  );
  const authorizationUrl = buildAuthorizeUrl({
    authorizationEndpoint: metadata.authorization_endpoint,
    clientId: SETUP_AUTH_CONFIG.clientId,
    redirectUri,
    scopes: SETUP_AUTH_CONFIG.scopes,
    state,
    codeChallenge,
  });

  browserLoginFlows.set(state, {
    codeVerifier,
    metadata,
    redirect,
    redirectUri,
    createdAt: Date.now(),
  });
  redirectResponse(response, authorizationUrl);
}

async function completeBrowserLoginFlow(flow, callbackResult, response) {
  const tokenResponse = await exchangeAuthorizationCode({
    metadata: flow.metadata,
    code: callbackResult.code,
    codeVerifier: flow.codeVerifier,
    redirectUri: flow.redirectUri,
  });
  const claims = await resolveClaims({
    tokenResponse,
    metadata: flow.metadata,
  });
  const session = buildSessionRecord({
    tokenResponse,
    metadata: flow.metadata,
    claims,
  });
  if (!session.user?.id || !session.user?.name) {
    session.user = resolvePorticoUserClaims(claims);
  }
  await persistSession(session);
  recordPersistedIdentityState(session, { interactive: true });

  const handoff = await postHumanSession(session, {
    handoff: true,
    redirect: flow.redirect,
  });
  const completeUrl = new URL(
    handoff.complete_url || '/',
    OPEN_WEBUI_HOME_URL,
  ).toString();
  redirectResponse(response, completeUrl);
}

async function handleCallbackRequest(request, response, requestUrl) {
  const state = requestUrl.searchParams.get('state') || '';
  const browserFlow = state ? browserLoginFlows.get(state) : null;
  if (browserFlow) {
    const result = classifyCallbackRequest({
      requestUrl: requestUrl.toString(),
      expectedState: state,
      expectedRedirectUri: browserFlow.redirectUri,
      acceptedRedirectUris: getAcceptedSetupAuthRedirectUris(),
      sanitizeProviderError: true,
    });
    if (result.type === 'success') {
      browserLoginFlows.delete(state);
      await completeBrowserLoginFlow(browserFlow, result, response);
      return true;
    }
    browserLoginFlows.delete(state);
    const normalized = normalizeError(result.error);
    logSetupAuthFailure(result.error, normalized);
    writeHtmlResponse(response, 400, ERROR_PAGE);
    return true;
  }

  const waiter = state ? callbackWaiters.get(state) : null;
  if (!waiter) {
    writeHtmlResponse(response, 400, ERROR_PAGE);
    return true;
  }

  const result = classifyCallbackRequest({
    requestUrl: requestUrl.toString(),
    expectedState: waiter.expectedState,
    expectedRedirectUri: waiter.expectedRedirectUri,
    acceptedRedirectUris: waiter.acceptedRedirectUris,
    sanitizeProviderError: true,
  });

  if (result.type === 'success') {
    writeHtmlResponse(response, 200, SUCCESS_PAGE);
    settleCallbackWaiter(waiter, result);
    return true;
  }
  writeHtmlResponse(response, 400, ERROR_PAGE);
  settleCallbackWaiter(waiter, result);
  return true;
}

function handleBrokerRequest(request, response) {
  void (async () => {
    const redirectUrl = new URL(getSetupAuthRedirectUri());
    const requestOrigin = `http://${request.headers.host || redirectUrl.host}`;
    const requestUrl = new URL(request.url || '/', requestOrigin);
    if (requestUrl.pathname === '/owui/login') {
      await handleBrowserLoginRequest(requestUrl, response);
      return;
    }
    if (requestUrl.pathname === SETUP_AUTH_CONFIG.redirectPath) {
      await handleCallbackRequest(request, response, requestUrl);
      return;
    }
    writeHtmlResponse(response, 404, ERROR_PAGE);
  })().catch((error) => {
    const normalized = normalizeError(error);
    logSetupAuthFailure(error, normalized);
    console.warn(`[setup-auth] Broker request failed (${normalized.code})`);
    if (!response.headersSent) {
      writeHtmlResponse(response, 500, ERROR_PAGE);
    } else {
      response.end();
    }
  });
}

function listenOnce(server, port, hostname) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, hostname);
  });
}

function ensureSetupAuthBroker() {
  if (brokerReadyPromise) {
    return brokerReadyPromise;
  }

  brokerReadyPromise = (async () => {
    const redirectUrl = new URL(getSetupAuthRedirectUri());
    const retryDelayMs = SETUP_AUTH_CONFIG.brokerBindRetryDelayMs ?? 500;
    const maxWaitMs = SETUP_AUTH_CONFIG.brokerBindMaxWaitMs ?? 10000;
    const deadline = Date.now() + maxWaitMs;
    let warnedAboutBusyPort = false;

    const server = http.createServer(handleBrokerRequest);
    brokerServer = server;

    // A relaunched app instance can race the old instance's shutdown for the
    // callback port, so retry EADDRINUSE binds with bounded one-shot delays
    // (no recurring timers) until the deadline.
    for (;;) {
      try {
        await listenOnce(server, redirectUrl.port, redirectUrl.hostname);
        break;
      } catch (error) {
        if (error?.code !== 'EADDRINUSE' || Date.now() + retryDelayMs > deadline) {
          brokerServer = null;
          brokerReadyPromise = null;
          throw createBrokerListenerError(error, redirectUrl);
        }
        if (!warnedAboutBusyPort) {
          warnedAboutBusyPort = true;
          console.warn(
            `[setup-auth] Okta callback port ${redirectUrl.port} is busy — an old app instance may still be shutting down; retrying for up to ${maxWaitMs}ms`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    // Post-listen errors invalidate the broker so the next caller rebinds.
    server.on('error', (error) => {
      console.warn('[setup-auth] Okta callback broker error:', error.message);
      if (brokerServer === server) {
        brokerServer = null;
        brokerReadyPromise = null;
      }
    });

    // Don't let the broker keep the Node.js event loop alive on its own;
    // the Electron main process stays alive via its own handles.
    server.unref?.();
  })();

  return brokerReadyPromise;
}

async function stopSetupAuthBroker() {
  const server = brokerServer;
  brokerServer = null;
  brokerReadyPromise = null;
  if (!server) {
    return;
  }

  await new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function waitForAuthorizationCallback({
  expectedState,
  expectedRedirectUri,
  acceptedRedirectUris = [],
}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const waiter = callbackWaiters.get(expectedState);
      if (!waiter || waiter.settled) {
        return;
      }
      settleCallbackWaiter(waiter, {
        type: 'error',
        error: createSetupAuthError(
          'Timed out waiting for Okta to complete setup login',
          'auth_timeout',
        ),
      });
    }, SETUP_AUTH_CONFIG.authTimeoutMs);

    callbackWaiters.set(expectedState, {
      acceptedRedirectUris,
      expectedRedirectUri,
      expectedState,
      reject,
      resolve,
      settled: false,
      timeout,
    });
  });
}

const SAFE_SETUP_AUTH_ERROR_MESSAGES = Object.freeze({
  access_denied:
    'Okta denied access to this app. Try again or confirm that your account can use this Okta application.',
  access_denied_user_cancelled:
    'Sign-in was canceled. Try again when you are ready.',
  auth_storage_unavailable:
    'Secure token storage is unavailable on this device, so setup login cannot continue.',
  auth_timeout: 'Okta took too long to finish. Try again.',
  browser_open_failed:
    'The app could not open Okta in your browser. Try again.',
  callback_listener_failed:
    'The app could not open the local Okta callback port. Try again.',
  discovery_failed:
    'The app could not contact Okta to start sign-in. Try again.',
  discovery_invalid:
    'Okta returned an invalid sign-in configuration. Contact support.',
  missing_authorization_code:
    'Okta did not return the code needed to finish sign-in. Try again.',
  missing_refresh_token:
    'The saved login cannot be refreshed. Sign in again.',
  oauth_provider_error:
    'Okta could not complete sign-in. Try again.',
  oauth_request_failed:
    'The app could not complete the Okta request. Try again.',
  redirect_uri_mismatch:
    'The Okta callback did not match the request. Try again.',
  refresh_failed:
    'The saved Okta login could not be refreshed. Sign in again.',
  setup_auth_failed: 'Setup login failed. Please try again.',
  state_mismatch:
    'The Okta callback did not match the request. Try again.',
  token_exchange_failed:
    'Okta rejected the final sign-in step. Try again once; if it keeps failing, contact support.',
});

function normalizeError(error) {
  const requestedCode =
    typeof error?.code === 'string' ? error.code : 'setup_auth_failed';
  const code = Object.prototype.hasOwnProperty.call(
    SAFE_SETUP_AUTH_ERROR_MESSAGES,
    requestedCode,
  )
    ? requestedCode
    : 'setup_auth_failed';
  if (
    code === 'access_denied' &&
    error?.oauthResponseSummary?.reason === 'user_cancelled'
  ) {
    return {
      code: 'access_denied_user_cancelled',
      message: SAFE_SETUP_AUTH_ERROR_MESSAGES.access_denied_user_cancelled,
    };
  }

  return { code, message: SAFE_SETUP_AUTH_ERROR_MESSAGES[code] };
}

function logSetupAuthFailure(error, normalized) {
  const summary = error?.oauthResponseSummary || {};
  const diagnostic = {
    event: 'setup_auth_failed',
    failure: normalized.code,
    httpStatus: Number.isInteger(summary.status) ? summary.status : null,
    provider: summary.providerCode || null,
    reason: summary.reason || null,
    bodyKind: summary.bodyKind || null,
  };

  try {
    logOAuth('Electron', 'ERROR', JSON.stringify(diagnostic));
  } catch {
    try {
      console.warn('[setup-auth] OAuth diagnostic logging failed');
    } catch {
      // Diagnostics must never replace the stable setup-auth failure result.
    }
  }
}

async function getCachedSessionSummary() {
  setStatus({
    phase: 'checking-session',
    inProgress: false,
    error: null,
    errorCode: null,
    message: null,
  });

  try {
    const existingSession = await loadStoredSession();
    if (!existingSession) {
      setStatus({
        phase: 'idle',
        authenticated: false,
        sessionSummary: null,
      });
      return { authenticated: false, sessionSummary: null };
    }

    if (!isSessionExpired(existingSession)) {
      const sessionSummary = buildSessionSummary(existingSession);
      setStatus({
        phase: 'authenticated',
        authenticated: true,
        sessionSummary,
      });
      return { authenticated: true, sessionSummary, source: 'cache' };
    }

    if (existingSession.refreshToken) {
      try {
        const refreshedSession = await refreshSession(existingSession);
        const sessionSummary = buildSessionSummary(refreshedSession);
        setStatus({
          phase: 'authenticated',
          authenticated: true,
          sessionSummary,
        });
        return { authenticated: true, sessionSummary, source: 'refresh' };
      } catch (error) {
        await clearStoredSession();
        setStatus({
          phase: 'idle',
          authenticated: false,
          sessionSummary: null,
        });
        return {
          authenticated: false,
          sessionSummary: null,
          source: 'refresh_failed',
          refreshError: normalizeError(error),
        };
      }
    }

    await clearStoredSession();
    setStatus({
      phase: 'idle',
      authenticated: false,
      sessionSummary: null,
    });
    return { authenticated: false, sessionSummary: null, source: 'expired' };
  } catch (error) {
    // Session self-heal keys on the RAW storage error codes: normalizeError is
    // the closed user-facing OAuth classifier and would collapse these to
    // setup_auth_failed, hiding the "just re-auth" signal.
    const rawCode = typeof error?.code === 'string' ? error.code : '';
    if (
      ['session_decrypt_failed', 'session_parse_failed', 'session_read_failed'].includes(
        rawCode,
      )
    ) {
      // The stored session is unusable (and has already been cleared where
      // possible). Treat this as "not signed in" so launch proceeds straight
      // to re-auth instead of surfacing an error phase.
      setStatus({
        phase: 'idle',
        authenticated: false,
        sessionSummary: null,
      });
      return {
        authenticated: false,
        sessionSummary: null,
        source: 'session_unreadable',
        errorCode: rawCode,
      };
    }
    const normalized = normalizeError(error);
    setStatus({
      phase: 'error',
      authenticated: false,
      error: normalized.message,
      errorCode: normalized.code,
      sessionSummary: null,
    });
    return {
      authenticated: false,
      sessionSummary: null,
      error: normalized.message,
      errorCode: normalized.code,
    };
  }
}

// On-demand silent backfill for an authenticated session that is missing its
// email (PORTICO-414): fetch userinfo with the still-valid access token and
// persist the repaired identity. Single-flight, and serialized against
// refresh so the two can never interleave persists. Never touches expired
// sessions — the refresh path owns those (and now backfills email itself).
let activeIdentityRepairPromise = null;

function repairSessionIdentity() {
  if (activeIdentityRepairPromise) {
    return activeIdentityRepairPromise;
  }
  activeIdentityRepairPromise = runExclusiveSessionMutation(() =>
    repairSessionIdentityInner(),
  ).finally(() => {
    activeIdentityRepairPromise = null;
  });
  return activeIdentityRepairPromise;
}

async function repairSessionIdentityInner() {
  let session;
  try {
    session = await loadStoredSession();
  } catch {
    return { authenticated: false, repaired: false, reason: 'session_unreadable' };
  }
  if (!session) {
    return { authenticated: false, repaired: false, reason: 'no_session' };
  }
  if (isSessionExpired(session)) {
    return { authenticated: false, repaired: false, reason: 'session_expired' };
  }

  const sessionSummary = buildSessionSummary(session);
  if (normalizePlausibleEmail(session.user?.email)) {
    return {
      authenticated: true,
      sessionSummary,
      repaired: false,
      reason: 'email_present',
    };
  }

  const fallbackClaims = sessionFallbackClaims(session);
  let userInfo = {};
  if (session.userinfoEndpoint) {
    userInfo = await fetchUserInfo({
      metadata: { userinfo_endpoint: session.userinfoEndpoint },
      accessToken: session.accessToken,
    });
  } else {
    // Legacy records may predate the stored endpoint; discovery is the
    // fallback, and a discovery outage just reports email_unavailable.
    try {
      const metadata = await discoverMetadata();
      userInfo = await fetchUserInfo({
        metadata,
        accessToken: session.accessToken,
      });
    } catch {
      userInfo = {};
    }
  }

  const email = selectCanonicalEmail({ userInfo, fallbackClaims });
  if (!email) {
    return {
      authenticated: true,
      sessionSummary,
      repaired: false,
      reason: 'email_unavailable',
      emailUnavailable: true,
      terminal: interactiveEmaillessAt !== null,
    };
  }

  const mergedClaims = { ...userInfo, ...fallbackClaims };
  mergedClaims.email = email;
  const nextSession = { ...session, user: resolvePorticoUserClaims(mergedClaims) };
  await persistSession(nextSession);
  recordPersistedIdentityState(nextSession);
  const repairedSummary = buildSessionSummary(nextSession);
  setStatus({
    phase: 'authenticated',
    authenticated: true,
    sessionSummary: repairedSummary,
    error: null,
    errorCode: null,
    message: null,
  });
  try {
    logOAuth(
      'Electron',
      'INFO',
      JSON.stringify({ event: 'setup_auth_identity_repaired' }),
    );
  } catch {
    // Diagnostics must never break repair.
  }
  return {
    authenticated: true,
    sessionSummary: repairedSummary,
    repaired: true,
    source: 'identity_repair',
  };
}

async function startSetupAuth() {
  if (activeLoginPromise) {
    return activeLoginPromise;
  }

  activeLoginPromise = (async () => {
    const cached = await getCachedSessionSummary();
    if (cached.authenticated) {
      if (normalizePlausibleEmail(cached.sessionSummary?.user?.email)) {
        return {
          success: true,
          authenticated: true,
          sessionSummary: cached.sessionSummary,
          source: cached.source,
        };
      }
      // Cached session lacks an email: silent backfill first; only if that
      // fails fall through to a full interactive re-auth (product-approved
      // forced re-auth for email-less sessions, PORTICO-414).
      const repair = await repairSessionIdentity();
      if (repair.repaired) {
        return {
          success: true,
          authenticated: true,
          sessionSummary: repair.sessionSummary,
          source: 'identity_repair',
        };
      }
    }

    ensureSecureStorageAvailable();

    const metadata = await discoverMetadata();
    const redirectUri = getSetupAuthRedirectUri();
    const { codeVerifier, codeChallenge } = createPkcePair();
    const state = createStateToken();
    const authorizationUrl = buildAuthorizeUrl({
      authorizationEndpoint: metadata.authorization_endpoint,
      clientId: SETUP_AUTH_CONFIG.clientId,
      redirectUri,
      scopes: SETUP_AUTH_CONFIG.scopes,
      state,
      codeChallenge,
    });

    setStatus({
      phase: 'opening-browser',
      inProgress: true,
      authenticated: false,
      error: null,
      errorCode: null,
      message: 'Opening Okta in your browser...',
      sessionSummary: null,
    });

    // Ensure the loopback callback broker is actually bound before opening the
    // browser. If the port is occupied this rejects with
    // `callback_listener_failed` and we never launch the external browser.
    await ensureSetupAuthBroker();

    const callbackOutcomePromise = waitForAuthorizationCallback({
      expectedState: state,
      expectedRedirectUri: redirectUri,
      acceptedRedirectUris: getAcceptedSetupAuthRedirectUris(),
    }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );

    try {
      await openHttpExternalUrl(shell, authorizationUrl);
    } catch (error) {
      const browserError = createSetupAuthError(
        'Failed to open Okta sign-in in the browser',
        'browser_open_failed',
        { cause: error },
      );
      const waiter = callbackWaiters.get(state);
      if (waiter) {
        settleCallbackWaiter(waiter, { type: 'error', error: browserError });
      }
      throw browserError;
    }

    setStatus({
      phase: 'waiting-callback',
      inProgress: true,
      message: 'Waiting for Okta to finish...',
    });

    const callbackOutcome = await callbackOutcomePromise;
    if (callbackOutcome.error) {
      throw callbackOutcome.error;
    }
    const callbackResult = callbackOutcome.value;

    setStatus({
      phase: 'exchanging-token',
      inProgress: true,
      message: 'Finishing sign-in...',
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
      claims,
    });

    if (!session.user?.id || !session.user?.name) {
      session.user = resolvePorticoUserClaims(claims);
    }

    await persistSession(session);
    // Email policy is enforced by the startup gate/guided setup, not here;
    // this only records whether a FRESH sign-in could produce an email so
    // automatic re-auth attempts know when to stop.
    recordPersistedIdentityState(session, { interactive: true });

    const sessionSummary = buildSessionSummary(session);
    setStatus({
      phase: 'authenticated',
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
      sessionSummary,
      source: 'interactive',
    };
  })()
    .catch((error) => {
      const normalized = normalizeError(error);
      logSetupAuthFailure(error, normalized);
      setStatus({
        phase: 'error',
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
        error: normalized.message,
        errorCode: normalized.code,
      };
    })
    .finally(() => {
      activeLoginPromise = null;
    });

  return await activeLoginPromise;
}

async function getAuthorizedSession() {
  const existingSession = await loadStoredSession();
  if (!existingSession) {
    throw createSetupAuthError(
      "No setup auth session is available yet",
      "auth_session_missing",
    );
  }

  if (!isSessionExpired(existingSession)) {
    const sessionSummary = buildSessionSummary(existingSession);
    setStatus({
      phase: "authenticated",
      authenticated: true,
      sessionSummary,
      error: null,
      errorCode: null,
      message: null,
    });
    return existingSession;
  }

  if (!existingSession.refreshToken) {
    await clearStoredSession();
    throw createSetupAuthError(
      "Setup auth session expired and cannot be refreshed",
      "auth_session_expired",
    );
  }

  const refreshed = await refreshSession(existingSession);
  const sessionSummary = buildSessionSummary(refreshed);
  setStatus({
    phase: "authenticated",
    authenticated: true,
    sessionSummary,
    error: null,
    errorCode: null,
    message: null,
  });
  return refreshed;
}

function clearSetupAuthError() {
  if (!currentStatus.error && !currentStatus.errorCode) {
    return cloneStatus();
  }

  return setStatus({
    phase: currentStatus.authenticated ? 'authenticated' : 'idle',
    error: null,
    errorCode: null,
    message: null,
  });
}

function getSetupAuthStatus() {
  return cloneStatus();
}

function startOwuiAuthBroker() {
  return ensureSetupAuthBroker();
}

void ensureSetupAuthBroker().catch((error) => {
  const normalized = normalizeError(error);
  logSetupAuthFailure(error, normalized);
  console.warn(
    `[setup-auth] Failed to start loopback auth broker (${normalized.code})`,
  );
});

module.exports = {
  clearSetupAuthError,
  getCachedSessionSummary,
  getAuthorizedSession,
  getSetupAuthStatus,
  repairSessionIdentity,
  startOwuiAuthBroker,
  startSetupAuth,
  stopSetupAuthBroker,
  _test: {
    fetchJson,
    logSetupAuthFailure,
    normalizeError,
  },
};
