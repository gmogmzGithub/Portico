// Shared, app-owned identity for local resource attribution. Values come only
// from the authenticated session; this module never consults the OS account or
// invents an email domain.

class CreatorIdentityError extends Error {
  constructor(message, code, cause = undefined) {
    super(message);
    this.name = "CreatorIdentityError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

async function resolveAuthenticatedCreatorIdentity(deps = {}) {
  const getCurrentUser = deps.getCurrentUser || require("./current-user").get;
  const { normalizePlausibleEmail } = require("./setup-auth-shared");
  let result;
  try {
    result = await getCurrentUser();
  } catch (error) {
    throw new CreatorIdentityError(
      "Could not resolve the authenticated user for creator attribution.",
      "missing_user_identity",
      error,
    );
  }

  const user = result?.sessionSummary?.user || {};
  const email = normalizePlausibleEmail(user.email) || "";
  if (result?.authenticated !== true || !email) {
    throw new CreatorIdentityError(
      "The authenticated user session does not contain an email address.",
      "missing_user_identity",
    );
  }

  const preferredUsername =
    typeof user.preferredUsername === "string" ? user.preferredUsername.trim() : "";
  const sessionId = typeof user.id === "string" ? user.id.trim() : "";
  const emailLocalPart = email.slice(0, email.indexOf("@")).trim();
  const ldapCandidate = preferredUsername || emailLocalPart || sessionId;
  const ldap = ldapCandidate.includes("@")
    ? ldapCandidate.slice(0, ldapCandidate.indexOf("@")).trim()
    : ldapCandidate;
  if (!ldap) {
    throw new CreatorIdentityError(
      "The authenticated user session does not contain an LDAP identity.",
      "missing_user_identity",
    );
  }
  return { email, ldap };
}

async function getCurrentCreatorIdentity(deps = {}) {
  return await resolveAuthenticatedCreatorIdentity(deps);
}

module.exports = {
  CreatorIdentityError,
  getCurrentCreatorIdentity,
  resolveAuthenticatedCreatorIdentity,
};
