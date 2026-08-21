const crypto = require('crypto');
const {
  SETUP_AUTH_CONFIG,
  getSetupAuthRedirectUri,
} = require('../config/setup-auth-config');

function createSetupAuthError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

const ALLOWED_OAUTH_PROVIDER_CODES = new Set([
  'access_denied',
  'consent_required',
  'interaction_required',
  'invalid_client',
  'invalid_grant',
  'invalid_request',
  'invalid_scope',
  'login_required',
  'server_error',
  'temporarily_unavailable',
  'unauthorized_client',
  'unsupported_grant_type',
  'unsupported_response_type',
]);

const OAUTH_RESPONSE_BODY_KINDS = new Set([
  'callback_query',
  'empty',
  'json_without_oauth_error',
  'oauth_error_json',
  'unparseable',
]);

function normalizeOAuthProviderCode(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return ALLOWED_OAUTH_PROVIDER_CODES.has(normalized)
    ? normalized
    : 'unrecognized';
}

function classifyOAuthErrorReason(providerCode, errorDescription) {
  if (typeof errorDescription !== 'string' || !errorDescription.trim()) {
    return 'none';
  }

  const description = errorDescription.toLowerCase().replace(/\s+/g, ' ');
  if (
    /access policy|not assigned|not authorized to (?:use|access)|policy.{0,40}(?:denied|rejected)/.test(
      description,
    )
  ) {
    return 'access_policy_denied';
  }
  if (
    providerCode === 'access_denied' &&
    /(?:end\s+)?user\s+(?:has\s+)?(?:denied|cancel(?:led|ed))\s+(?:the\s+)?(?:request|authorization|consent|access)|(?:request|authorization|consent|access)\s+(?:was\s+)?(?:denied|cancel(?:led|ed))\s+by\s+(?:the\s+)?(?:end\s+)?user/.test(
      description,
    )
  ) {
    return 'user_cancelled';
  }
  if (
    /authorization code.{0,120}(?:invalid|expired|used)|(?:invalid|expired|used).{0,120}authorization code/.test(
      description,
    )
  ) {
    return 'authorization_code_invalid_or_expired';
  }
  if (/offline_access|refresh token/.test(description)) {
    return 'offline_access_denied';
  }
  if (
    providerCode === 'invalid_client' ||
    /client authentication|client credentials|client.{0,40}(?:invalid|unauthorized)/.test(
      description,
    )
  ) {
    return 'client_authentication_failed';
  }

  return 'unclassified_description';
}

function createOAuthResponseSummary({
  status = null,
  bodyKind = 'unparseable',
  error = null,
  errorDescription = null,
} = {}) {
  const providerCode = normalizeOAuthProviderCode(error);
  return {
    status:
      Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    bodyKind: OAUTH_RESPONSE_BODY_KINDS.has(bodyKind)
      ? bodyKind
      : 'unparseable',
    providerCode,
    reason: classifyOAuthErrorReason(providerCode, errorDescription),
  };
}

function getSafeOAuthProviderMessage(summary = {}) {
  if (summary.reason === 'user_cancelled') {
    return 'User denied access';
  }
  if (summary.providerCode === 'access_denied') {
    return 'The identity provider denied the sign-in request';
  }
  return 'The identity provider could not complete sign-in';
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createPkcePair(randomBytes = crypto.randomBytes) {
  const codeVerifier = base64UrlEncode(randomBytes(64));
  const codeChallenge = base64UrlEncode(
    crypto.createHash('sha256').update(codeVerifier).digest(),
  );

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256',
  };
}

function createStateToken(randomBytes = crypto.randomBytes) {
  return base64UrlEncode(randomBytes(32));
}

function normalizeScopes(scopes = SETUP_AUTH_CONFIG.scopes) {
  if (Array.isArray(scopes)) {
    return [...new Set(scopes.map((scope) => String(scope).trim()).filter(Boolean))];
  }

  if (typeof scopes === 'string') {
    return [...new Set(scopes.split(/\s+/).map((scope) => scope.trim()).filter(Boolean))];
  }

  return [...SETUP_AUTH_CONFIG.scopes];
}

function buildAuthorizeUrl({
  authorizationEndpoint,
  clientId = SETUP_AUTH_CONFIG.clientId,
  redirectUri = getSetupAuthRedirectUri(),
  scopes = SETUP_AUTH_CONFIG.scopes,
  state,
  codeChallenge,
  extraParams = {},
}) {
  if (!authorizationEndpoint) {
    throw createSetupAuthError(
      'Missing authorization endpoint for setup auth',
      'missing_authorization_endpoint',
    );
  }
  if (!state) {
    throw createSetupAuthError('Missing OAuth state value', 'missing_state');
  }
  if (!codeChallenge) {
    throw createSetupAuthError(
      'Missing PKCE code challenge value',
      'missing_code_challenge',
    );
  }

  const url = new URL(authorizationEndpoint);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', normalizeScopes(scopes).join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  Object.entries(extraParams).forEach(([key, value]) => {
    if (value == null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  return url.toString();
}

function decodeJwtClaims(token) {
  if (typeof token !== 'string' || !token) {
    return {};
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return {};
  }

  try {
    const normalized = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function localPartFromEmail(email) {
  if (typeof email !== 'string') {
    return null;
  }
  const trimmed = email.trim();
  if (!trimmed.includes('@')) {
    return trimmed || null;
  }
  const localPart = trimmed.split('@')[0].trim();
  return localPart || null;
}

function normalizePlausibleEmail(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  const atIndex = trimmed.indexOf('@');
  if (atIndex < 1 || atIndex === trimmed.length - 1) {
    return null;
  }
  return trimmed;
}

// Canonical email precedence: the id_token minted by the CURRENT token
// response outranks userinfo fetched with the current access token, which
// outranks the previously persisted identity. Absence never erases — an
// email-less source falls through instead of clobbering a stored value.
function selectCanonicalEmail({ idTokenClaims = {}, userInfo = {}, fallbackClaims = {} } = {}) {
  return (
    normalizePlausibleEmail(idTokenClaims.email) ||
    normalizePlausibleEmail(userInfo.email) ||
    normalizePlausibleEmail(fallbackClaims.email) ||
    null
  );
}

// Legacy persisted records may lack user.claims; synthesize enough claim
// material from the stored user fields that refresh/repair merges cannot
// erase a previously good identity.
function sessionFallbackClaims(session) {
  const claims = session?.user?.claims;
  if (
    claims &&
    typeof claims === 'object' &&
    !Array.isArray(claims) &&
    Object.keys(claims).length > 0
  ) {
    return claims;
  }
  const user = session?.user || {};
  const synthesized = {};
  if (typeof user.preferredUsername === 'string' && user.preferredUsername) {
    synthesized.preferred_username = user.preferredUsername;
  }
  if (typeof user.name === 'string' && user.name) {
    synthesized.name = user.name;
  }
  if (typeof user.email === 'string' && user.email) {
    synthesized.email = user.email;
  }
  if (typeof user.id === 'string' && user.id) {
    synthesized.sub = user.id;
  }
  return synthesized;
}

function resolvePorticoUserClaims(rawClaims = {}) {
  const claims = rawClaims && typeof rawClaims === 'object' ? rawClaims : {};
  const preferredUsername = firstNonEmptyString(claims.preferred_username);
  const email = firstNonEmptyString(claims.email);
  const userId =
    preferredUsername ||
    localPartFromEmail(email) ||
    firstNonEmptyString(claims.sub) ||
    'unknown-user';
  const fullName =
    firstNonEmptyString(claims.name) ||
    firstNonEmptyString(
      [claims.given_name, claims.family_name].filter(Boolean).join(' ').trim(),
    ) ||
    userId;

  return {
    id: userId,
    name: fullName,
    email: normalizePlausibleEmail(claims.email),
    preferredUsername: preferredUsername || null,
    claims,
  };
}

function needsUserInfo(claims = {}, { requireEmail = false } = {}) {
  if (requireEmail && !normalizePlausibleEmail(claims.email)) {
    return true;
  }
  const hasUserId = Boolean(
    firstNonEmptyString(claims.preferred_username, localPartFromEmail(claims.email), claims.sub),
  );
  const hasName = Boolean(
    firstNonEmptyString(
      claims.name,
      [claims.given_name, claims.family_name].filter(Boolean).join(' ').trim(),
    ),
  );

  return !(hasUserId && hasName);
}

function computeExpiresAt(tokenResponse = {}, claims = {}, now = Date.now()) {
  const expiresIn = Number(tokenResponse.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    return now + expiresIn * 1000;
  }

  if (Number.isFinite(Number(tokenResponse.expires_at))) {
    return Number(tokenResponse.expires_at);
  }

  if (Number.isFinite(Number(claims.exp))) {
    return Number(claims.exp) * 1000;
  }

  return null;
}

function buildSessionRecord({
  tokenResponse = {},
  metadata = {},
  config = SETUP_AUTH_CONFIG,
  claims = {},
  now = Date.now(),
  // Storage vs identity separation: tokenResponse.id_token is what gets
  // STORED (it may be a retained token from a refresh that omitted one), but
  // only identityIdToken — the token minted by the current exchange — may
  // DETERMINE identity. Refresh callers pass null when the response had no
  // id_token so a stale retained token cannot outrank fresher claims.
  identityIdToken = tokenResponse.id_token,
}) {
  const idTokenClaims = decodeJwtClaims(identityIdToken);
  const mergedClaims = {
    ...(claims || {}),
    ...idTokenClaims,
  };
  mergedClaims.email = selectCanonicalEmail({
    idTokenClaims,
    fallbackClaims: claims || {},
  });

  return {
    version: 1,
    issuer: config.issuer,
    discoveryUrl: config.discoveryUrl,
    clientId: config.clientId,
    redirectUri: getSetupAuthRedirectUri(config.redirectHost),
    scopes: normalizeScopes(tokenResponse.scope || config.scopes),
    authorizationEndpoint: metadata.authorization_endpoint || metadata.authorizationEndpoint || null,
    tokenEndpoint: metadata.token_endpoint || metadata.tokenEndpoint || null,
    userinfoEndpoint: metadata.userinfo_endpoint || metadata.userinfoEndpoint || null,
    accessToken: tokenResponse.access_token || null,
    refreshToken: tokenResponse.refresh_token || null,
    idToken: tokenResponse.id_token || null,
    tokenType: tokenResponse.token_type || 'Bearer',
    issuedAt: now,
    expiresAt: computeExpiresAt(tokenResponse, mergedClaims, now),
    user: resolvePorticoUserClaims(mergedClaims),
  };
}

function isSessionExpired(
  session,
  { now = Date.now(), skewMs = SETUP_AUTH_CONFIG.tokenExpirySkewMs } = {},
) {
  if (!session || !Number.isFinite(Number(session.expiresAt))) {
    return true;
  }

  return Number(session.expiresAt) <= now + skewMs;
}

function buildSessionSummary(session) {
  if (!session || !session.accessToken) {
    return null;
  }

  return {
    authenticated: true,
    issuer: session.issuer,
    clientId: session.clientId,
    scopes: normalizeScopes(session.scopes),
    expiresAt: session.expiresAt || null,
    user: {
      id: session.user?.id || null,
      name: session.user?.name || null,
      email: session.user?.email || null,
      preferredUsername: session.user?.preferredUsername || null,
    },
  };
}

function buildAcceptedCallbackTargets(expectedRedirectUri, acceptedRedirectUris = []) {
  const targets = new Set();

  [expectedRedirectUri, ...acceptedRedirectUris].forEach((candidate) => {
    if (!candidate) {
      return;
    }

    try {
      const parsed = new URL(candidate);
      targets.add(`${parsed.origin}${parsed.pathname}`);
    } catch {
      // Ignore malformed fallback URIs from callers.
    }
  });

  return targets;
}

function classifyCallbackRequest({
  requestUrl,
  expectedState,
  expectedRedirectUri,
  acceptedRedirectUris = [],
  sanitizeProviderError = false,
}) {
  const actualUrl = new URL(requestUrl);
  const actualTarget = `${actualUrl.origin}${actualUrl.pathname}`;
  const acceptedTargets = buildAcceptedCallbackTargets(
    expectedRedirectUri,
    acceptedRedirectUris,
  );

  if (!acceptedTargets.has(actualTarget)) {
    return {
      type: 'ignore',
      error: createSetupAuthError(
        `OAuth redirect URI mismatch: expected one of ${Array.from(acceptedTargets).join(', ')} but received ${actualTarget}`,
        'redirect_uri_mismatch',
      ),
    };
  }

  const callbackState = actualUrl.searchParams.get('state');
  if (callbackState !== expectedState) {
    return {
      type: 'ignore',
      error: createSetupAuthError(
        'OAuth state mismatch detected while completing setup login',
        'state_mismatch',
      ),
    };
  }

  const providerError = actualUrl.searchParams.get('error');
  if (providerError) {
    if (sanitizeProviderError) {
      const oauthResponseSummary = createOAuthResponseSummary({
        bodyKind: 'callback_query',
        error: providerError,
        errorDescription: actualUrl.searchParams.get('error_description'),
      });
      return {
        type: 'error',
        error: createSetupAuthError(
          getSafeOAuthProviderMessage(oauthResponseSummary),
          providerError === 'access_denied'
            ? 'access_denied'
            : 'oauth_provider_error',
          { oauthResponseSummary },
        ),
      };
    }

    return {
      type: 'error',
      error: createSetupAuthError(
        actualUrl.searchParams.get('error_description') ||
          `Okta returned ${providerError} during setup login`,
        providerError === 'access_denied' ? 'access_denied' : 'oauth_provider_error',
        { providerError },
      ),
    };
  }

  const code = actualUrl.searchParams.get('code');
  if (!code) {
    return {
      type: 'error',
      error: createSetupAuthError(
        'Okta callback did not include an authorization code',
        'missing_authorization_code',
      ),
    };
  }

  return { type: 'success', code };
}

function validateCallbackRequest({
  requestUrl,
  expectedState,
  expectedRedirectUri,
  acceptedRedirectUris = [],
}) {
  const result = classifyCallbackRequest({
    requestUrl,
    expectedState,
    expectedRedirectUri,
    acceptedRedirectUris,
  });

  if (result.type === 'success') {
    return { code: result.code };
  }

  throw result.error;
}

function encryptSessionRecord(session, safeStorageLike) {
  if (!safeStorageLike || typeof safeStorageLike.encryptString !== 'function') {
    throw createSetupAuthError(
      'Missing safeStorage implementation for setup auth encryption',
      'missing_safe_storage',
    );
  }

  return safeStorageLike.encryptString(JSON.stringify(session));
}

function decryptSessionRecord(buffer, safeStorageLike) {
  if (!safeStorageLike || typeof safeStorageLike.decryptString !== 'function') {
    throw createSetupAuthError(
      'Missing safeStorage implementation for setup auth decryption',
      'missing_safe_storage',
    );
  }

  return JSON.parse(safeStorageLike.decryptString(buffer));
}

module.exports = {
  buildAuthorizeUrl,
  classifyCallbackRequest,
  buildSessionRecord,
  buildSessionSummary,
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
  normalizeScopes,
  resolvePorticoUserClaims,
  selectCanonicalEmail,
  sessionFallbackClaims,
  validateCallbackRequest,
};
