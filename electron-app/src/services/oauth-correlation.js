const OAUTH_CORRELATION_EVENTS = new Set([
  "authorization_opened",
  "authorization_restarted",
  "reauthorization_opened",
  "callback_received",
  "callback_timeout",
  "authorization_failed",
]);

function sanitizeIdentifier(value, fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .slice(0, 160);
  return normalized || fallback;
}

function urlWithoutQueryOrFragment(rawUrl) {
  if (!rawUrl) return null;
  const parsed = new URL(String(rawUrl));
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

function summarizeOAuthCorrelation(payload = {}) {
  const event = String(payload.event || "").trim();
  if (!OAUTH_CORRELATION_EVENTS.has(event)) {
    throw new Error("Unsupported OAuth correlation event");
  }

  let authorizationHost = null;
  let redirectUri = null;
  if (payload.authorizationUrl) {
    const authorizationUrl = new URL(String(payload.authorizationUrl));
    if (!/^https?:$/.test(authorizationUrl.protocol)) {
      throw new Error("OAuth authorization URL must use HTTP or HTTPS");
    }
    authorizationHost = authorizationUrl.host;
    const rawRedirectUri = authorizationUrl.searchParams.get("redirect_uri");
    if (rawRedirectUri) {
      redirectUri = urlWithoutQueryOrFragment(rawRedirectUri);
    }
  }

  return {
    event,
    sessionId: sanitizeIdentifier(payload.sessionId),
    authorizationHost,
    redirectUri,
    callbackReceived:
      typeof payload.callbackReceived === "boolean"
        ? payload.callbackReceived
        : event === "callback_received",
  };
}

function formatOAuthCorrelation(payload) {
  return `OAuth correlation ${JSON.stringify(summarizeOAuthCorrelation(payload))}`;
}

module.exports = {
  OAUTH_CORRELATION_EVENTS,
  formatOAuthCorrelation,
  sanitizeIdentifier,
  summarizeOAuthCorrelation,
  urlWithoutQueryOrFragment,
};
