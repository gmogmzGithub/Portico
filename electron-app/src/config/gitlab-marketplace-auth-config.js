const { LOCAL_SERVICE_PORTS } = require("./local-service-ports");

const DEFAULT_BASE_URL =
  process.env.GITLAB_MARKETPLACE_BASE_URL || "https://example.invalid";
const DEFAULT_CLIENT_ID =
  process.env.GITLAB_MARKETPLACE_CLIENT_ID ||
  "65a247346ee181c726bf686af59f770ee023281294f542eab3803848919bc5fc";
const DEFAULT_SCOPES = (
  process.env.GITLAB_MARKETPLACE_SCOPES ||
  "openid profile email read_repository read_api"
)
  .split(/\s+/)
  .map((scope) => scope.trim())
  .filter(Boolean);
const REDIRECT_HOST = "127.0.0.1";
const REDIRECT_PORT = LOCAL_SERVICE_PORTS.gitlabMarketplaceAuthCallback;
const REDIRECT_PATH = "/gitlab/callback";
const ACCEPTED_REDIRECT_HOSTS = ["127.0.0.1", "localhost"];

const normalizedBaseUrl = DEFAULT_BASE_URL.replace(/\/+$/, "");
const defaultHost = new URL(normalizedBaseUrl).host;

const GITLAB_MARKETPLACE_AUTH_CONFIG = Object.freeze({
  issuer: normalizedBaseUrl,
  baseUrl: normalizedBaseUrl,
  discoveryUrl: `${normalizedBaseUrl}/.well-known/openid-configuration`,
  clientId: DEFAULT_CLIENT_ID,
  clientSecret: process.env.GITLAB_MARKETPLACE_CLIENT_SECRET || "",
  clientType: "native",
  scopes: DEFAULT_SCOPES,
  redirectHost: REDIRECT_HOST,
  redirectPort: REDIRECT_PORT,
  redirectPath: REDIRECT_PATH,
  acceptedRedirectHosts: ACCEPTED_REDIRECT_HOSTS,
  authTimeoutMs: 180000,
  networkTimeoutMs: 30000,
  tokenExpirySkewMs: 60000,
  sessionFileName: "gitlab-marketplace-auth-session.bin",
  allowedHosts: [defaultHost],
});

function getGitlabMarketplaceAuthRedirectUri(
  host = GITLAB_MARKETPLACE_AUTH_CONFIG.redirectHost,
) {
  return `http://${host}:${GITLAB_MARKETPLACE_AUTH_CONFIG.redirectPort}${GITLAB_MARKETPLACE_AUTH_CONFIG.redirectPath}`;
}

function getAcceptedGitlabMarketplaceAuthRedirectUris() {
  return GITLAB_MARKETPLACE_AUTH_CONFIG.acceptedRedirectHosts.map((host) =>
    getGitlabMarketplaceAuthRedirectUri(host),
  );
}

module.exports = {
  GITLAB_MARKETPLACE_AUTH_CONFIG,
  getGitlabMarketplaceAuthRedirectUri,
  getAcceptedGitlabMarketplaceAuthRedirectUris,
};
