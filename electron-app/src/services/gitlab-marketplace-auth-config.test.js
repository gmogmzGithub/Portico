const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GITLAB_MARKETPLACE_AUTH_CONFIG,
  getGitlabMarketplaceAuthRedirectUri,
} = require("../config/gitlab-marketplace-auth-config");

test("GitLab marketplace auth config uses the provisioned client and redirect", () => {
  assert.equal(
    GITLAB_MARKETPLACE_AUTH_CONFIG.clientId,
    "65a247346ee181c726bf686af59f770ee023281294f542eab3803848919bc5fc",
  );
  assert.equal(
    GITLAB_MARKETPLACE_AUTH_CONFIG.baseUrl,
    "https://example.invalid",
  );
  assert.deepEqual(GITLAB_MARKETPLACE_AUTH_CONFIG.scopes, [
    "openid",
    "profile",
    "email",
    "read_repository",
    "read_api",
  ]);
  assert.equal(
    getGitlabMarketplaceAuthRedirectUri(),
    "http://127.0.0.1:8878/gitlab/callback",
  );
});
