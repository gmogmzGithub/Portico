const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAuthorizeUrl,
  buildSessionRecord,
  classifyCallbackRequest,
  createPkcePair,
  decryptSessionRecord,
  encryptSessionRecord,
  isSessionExpired,
  needsUserInfo,
  normalizePlausibleEmail,
  resolvePorticoUserClaims,
  selectCanonicalEmail,
  sessionFallbackClaims,
  validateCallbackRequest,
} = require('./setup-auth-shared');

function encodeJwt(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

test('buildAuthorizeUrl includes Authorization Code + PKCE parameters', () => {
  const { codeChallenge } = createPkcePair(() => Buffer.alloc(64, 7));
  const url = new URL(
    buildAuthorizeUrl({
      authorizationEndpoint: 'https://id.example.invalid/oauth2/default/v1/authorize',
      clientId: 'client-123',
      redirectUri: 'http://127.0.0.1:8877/callback',
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      state: 'state-123',
      codeChallenge,
    }),
  );

  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'http://127.0.0.1:8877/callback',
  );
  assert.equal(
    url.searchParams.get('scope'),
    'openid profile email offline_access',
  );
  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), codeChallenge);
});

test('validateCallbackRequest accepts configured localhost loopback redirects', () => {
  assert.deepEqual(
    validateCallbackRequest({
      requestUrl: 'http://localhost:8877/callback?code=abc&state=state-123',
      expectedState: 'state-123',
      expectedRedirectUri: 'http://127.0.0.1:8877/callback',
      acceptedRedirectUris: ['http://localhost:8877/callback'],
    }),
    { code: 'abc' },
  );
});

test('classifyCallbackRequest distinguishes ignorable mismatches from terminal failures', () => {
  const redirectMismatch = classifyCallbackRequest({
    requestUrl: 'http://127.0.0.1:9999/callback?code=abc&state=state-123',
    expectedState: 'state-123',
    expectedRedirectUri: 'http://127.0.0.1:8877/callback',
    acceptedRedirectUris: ['http://localhost:8877/callback'],
  });
  assert.equal(redirectMismatch.type, 'ignore');
  assert.equal(redirectMismatch.error.code, 'redirect_uri_mismatch');

  const stateMismatch = classifyCallbackRequest({
    requestUrl: 'http://127.0.0.1:8877/callback?code=abc&state=wrong',
    expectedState: 'state-123',
    expectedRedirectUri: 'http://127.0.0.1:8877/callback',
  });
  assert.equal(stateMismatch.type, 'ignore');
  assert.equal(stateMismatch.error.code, 'state_mismatch');

  const providerFailure = classifyCallbackRequest({
    requestUrl: 'http://127.0.0.1:8877/callback?error=access_denied&error_description=User%20denied&state=state-123',
    expectedState: 'state-123',
    expectedRedirectUri: 'http://127.0.0.1:8877/callback',
  });
  assert.equal(providerFailure.type, 'error');
  assert.equal(providerFailure.error.code, 'access_denied');
});

test('validateCallbackRequest rejects mismatched state', () => {
  assert.throws(
    () =>
      validateCallbackRequest({
        requestUrl: 'http://127.0.0.1:8877/callback?code=abc&state=wrong',
        expectedState: 'state-123',
        expectedRedirectUri: 'http://127.0.0.1:8877/callback',
      }),
    /state mismatch/i,
  );
});

test('encryptSessionRecord and decryptSessionRecord round-trip session payloads', () => {
  const fakeSafeStorage = {
    encryptString(value) {
      return Buffer.from(value, 'utf8');
    },
    decryptString(value) {
      return Buffer.from(value).toString('utf8');
    },
  };

  const session = {
    accessToken: 'access',
    refreshToken: 'refresh',
    user: { id: 'jdoe', name: 'Jane Doe' },
  };

  const encrypted = encryptSessionRecord(session, fakeSafeStorage);
  const decrypted = decryptSessionRecord(encrypted, fakeSafeStorage);
  assert.deepEqual(decrypted, session);
});

test('resolvePorticoUserClaims follows preferred username and name precedence', () => {
  const preferred = resolvePorticoUserClaims({
    preferred_username: 'jdoe',
    email: 'jdoe@example.invalid',
    name: 'Jane Doe',
  });
  assert.equal(preferred.id, 'jdoe');
  assert.equal(preferred.name, 'Jane Doe');

  const fallback = resolvePorticoUserClaims({
    email: 'john.smith@example.invalid',
    given_name: 'John',
    family_name: 'Smith',
  });
  assert.equal(fallback.id, 'john.smith');
  assert.equal(fallback.name, 'John Smith');
});

test('buildSessionRecord computes expiry metadata and session expiry status', () => {
  const now = 1_700_000_000_000;
  const session = buildSessionRecord({
    tokenResponse: {
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: 'header.eyJzdWIiOiJqZG9lIn0.signature',
      expires_in: 3600,
    },
    metadata: {
      authorization_endpoint: 'https://id.example.invalid/authorize',
      token_endpoint: 'https://id.example.invalid/token',
    },
    claims: {
      preferred_username: 'jdoe',
      name: 'Jane Doe',
    },
    now,
  });

  assert.equal(session.expiresAt, now + 3600 * 1000);
  assert.equal(isSessionExpired(session, { now }), false);
  assert.equal(
    isSessionExpired(session, { now: now + 3600 * 1000 + 1, skewMs: 0 }),
    true,
  );
});

test('normalizePlausibleEmail accepts only trimmed values with a local part and domain', () => {
  assert.equal(normalizePlausibleEmail('jdoe@example.invalid'), 'jdoe@example.invalid');
  assert.equal(normalizePlausibleEmail('  jdoe@example.invalid  '), 'jdoe@example.invalid');
  assert.equal(normalizePlausibleEmail('x@'), null);
  assert.equal(normalizePlausibleEmail('@x'), null);
  assert.equal(normalizePlausibleEmail('jdoe'), null);
  assert.equal(normalizePlausibleEmail('   '), null);
  assert.equal(normalizePlausibleEmail(''), null);
  assert.equal(normalizePlausibleEmail(null), null);
  assert.equal(normalizePlausibleEmail(42), null);
});

test('selectCanonicalEmail prefers fresh id_token, then userinfo, then fallback; implausible values fall through', () => {
  assert.equal(
    selectCanonicalEmail({
      idTokenClaims: { email: 'token@example.invalid' },
      userInfo: { email: 'userinfo@example.invalid' },
      fallbackClaims: { email: 'cached@example.invalid' },
    }),
    'token@example.invalid',
  );
  assert.equal(
    selectCanonicalEmail({
      idTokenClaims: {},
      userInfo: { email: 'userinfo@example.invalid' },
      fallbackClaims: { email: 'cached@example.invalid' },
    }),
    'userinfo@example.invalid',
  );
  assert.equal(
    selectCanonicalEmail({
      idTokenClaims: { email: 'not-an-email' },
      userInfo: { email: 'userinfo@example.invalid' },
    }),
    'userinfo@example.invalid',
  );
  assert.equal(
    selectCanonicalEmail({ fallbackClaims: { email: 'cached@example.invalid' } }),
    'cached@example.invalid',
  );
  assert.equal(selectCanonicalEmail({}), null);
  assert.equal(selectCanonicalEmail(), null);
});

test('needsUserInfo requires an email only when asked, keeping the default decision unchanged', () => {
  const idAndNameNoEmail = { preferred_username: 'jdoe', name: 'Jane Doe' };
  assert.equal(needsUserInfo(idAndNameNoEmail), false);
  assert.equal(needsUserInfo(idAndNameNoEmail, { requireEmail: true }), true);
  assert.equal(
    needsUserInfo(
      { ...idAndNameNoEmail, email: 'jdoe@example.invalid' },
      { requireEmail: true },
    ),
    false,
  );
  assert.equal(
    needsUserInfo({ ...idAndNameNoEmail, email: 'bogus' }, { requireEmail: true }),
    true,
  );
  assert.equal(needsUserInfo({}, { requireEmail: true }), true);
});

test('sessionFallbackClaims passes through stored claims and synthesizes from legacy records', () => {
  const stored = { preferred_username: 'jdoe', name: 'Jane Doe', email: 'jdoe@example.invalid' };
  assert.equal(sessionFallbackClaims({ user: { claims: stored } }), stored);

  assert.deepEqual(
    sessionFallbackClaims({
      user: {
        id: 'jdoe',
        name: 'Jane Doe',
        email: 'jdoe@example.invalid',
        preferredUsername: 'jdoe',
      },
    }),
    {
      preferred_username: 'jdoe',
      name: 'Jane Doe',
      email: 'jdoe@example.invalid',
      sub: 'jdoe',
    },
  );

  assert.deepEqual(
    sessionFallbackClaims({ user: { id: 'jdoe', name: 'Jane Doe', claims: {} } }),
    { name: 'Jane Doe', sub: 'jdoe' },
  );
  assert.deepEqual(sessionFallbackClaims(null), {});
});

test('resolvePorticoUserClaims nulls an implausible email without changing id/name derivation', () => {
  const resolved = resolvePorticoUserClaims({
    preferred_username: 'jdoe',
    name: 'Jane Doe',
    email: 'not-an-email',
  });
  assert.equal(resolved.id, 'jdoe');
  assert.equal(resolved.name, 'Jane Doe');
  assert.equal(resolved.email, null);
});

test('buildSessionRecord stores the retained id_token but never lets it determine identity', () => {
  const retainedToken = encodeJwt({
    preferred_username: 'jdoe',
    name: 'Jane Doe',
    email: 'stale@example.invalid',
  });
  const claimsWithFreshEmail = {
    preferred_username: 'jdoe',
    name: 'Jane Doe',
    email: 'fresh@example.invalid',
  };

  const refreshShaped = buildSessionRecord({
    tokenResponse: {
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: retainedToken,
      expires_in: 3600,
    },
    metadata: {},
    claims: claimsWithFreshEmail,
    identityIdToken: null,
    now: 1_700_000_000_000,
  });
  assert.equal(refreshShaped.user.email, 'fresh@example.invalid');
  assert.equal(refreshShaped.idToken, retainedToken);

  // Default parameter: a token minted by the current exchange still wins.
  const interactiveShaped = buildSessionRecord({
    tokenResponse: {
      access_token: 'access',
      id_token: retainedToken,
      expires_in: 3600,
    },
    metadata: {},
    claims: claimsWithFreshEmail,
    now: 1_700_000_000_000,
  });
  assert.equal(interactiveShaped.user.email, 'stale@example.invalid');
});

test('buildSessionRecord preserves a claims-borne email when the current exchange minted no id_token', () => {
  const session = buildSessionRecord({
    tokenResponse: {
      access_token: 'access',
      expires_in: 3600,
    },
    metadata: {},
    claims: { preferred_username: 'jdoe', name: 'Jane Doe', email: 'kept@example.invalid' },
    identityIdToken: null,
    now: 1_700_000_000_000,
  });
  assert.equal(session.user.email, 'kept@example.invalid');
  assert.equal(session.idToken, null);
});
