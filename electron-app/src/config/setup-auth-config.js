const { LOCAL_SERVICE_PORTS } = require('./local-service-ports');

const DEFAULT_ISSUER = process.env.SETUP_AUTH_ISSUER || 'https://id.example.invalid/oauth2/default';
const DEFAULT_CLIENT_ID =
  process.env.SETUP_AUTH_CLIENT_ID || '0oatwbg0ephJywyTF4x7';
const DEFAULT_SCOPES = ['openid', 'profile', 'email', 'offline_access'];
const REDIRECT_HOST = '127.0.0.1';
const REDIRECT_PORT = LOCAL_SERVICE_PORTS.setupAuthCallback;
const REDIRECT_PATH = '/callback';
const ACCEPTED_REDIRECT_HOSTS = ['127.0.0.1', 'localhost'];

const SETUP_AUTH_CONFIG = Object.freeze({
  issuer: DEFAULT_ISSUER,
  discoveryUrl: `${DEFAULT_ISSUER}/.well-known/openid-configuration`,
  clientId: DEFAULT_CLIENT_ID,
  clientType: 'native',
  scopes: DEFAULT_SCOPES,
  redirectHost: REDIRECT_HOST,
  redirectPort: REDIRECT_PORT,
  redirectPath: REDIRECT_PATH,
  acceptedRedirectHosts: ACCEPTED_REDIRECT_HOSTS,
  authTimeoutMs: 180000,
  networkTimeoutMs: 30000,
  tokenExpirySkewMs: 60000,
  sessionFileName: 'setup-auth-session.bin',
  // A relaunched app instance can race the old instance's shutdown for the
  // loopback callback port. Bound how long broker binding retries EADDRINUSE.
  brokerBindMaxWaitMs: 10000,
  brokerBindRetryDelayMs: 500,
});

function getSetupAuthRedirectUri(host = SETUP_AUTH_CONFIG.redirectHost) {
  return `http://${host}:${SETUP_AUTH_CONFIG.redirectPort}${SETUP_AUTH_CONFIG.redirectPath}`;
}

function getAcceptedSetupAuthRedirectUris() {
  return SETUP_AUTH_CONFIG.acceptedRedirectHosts.map((host) =>
    getSetupAuthRedirectUri(host),
  );
}

module.exports = {
  SETUP_AUTH_CONFIG,
  getSetupAuthRedirectUri,
  getAcceptedSetupAuthRedirectUris,
};
