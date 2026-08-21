// api-request-log-policy.js - PORTICO-443
//
// Which API routes get a per-request log line.
//
// The request-logging middleware used to emit one line per request for every
// route. In the session that produced the PORTICO-443 crash that meant 9,654 lines for
// `/api/oauth-log` alone -- an endpoint whose entire job is to write a log, so the
// middleware was announcing a write whose payload had already been recorded by
// logOAuth. Together with the status-poll routes it accounted for 27.1% of the
// day's main-process log.
//
// Extracted from api.js so the policy is testable: api.js requires electron and
// cannot be loaded under `node --test`, which is why the previous coverage for
// this behaviour was a regex matched against api.js's source text.

// Routes whose successful requests carry no information the app does not already
// record elsewhere. Failures are always logged -- a quiet app is only an
// improvement while nothing is going wrong.
const LOG_ONLY_ON_FAILURE_ROUTES = Object.freeze([
  "/api/server-readiness",
  "/api/oauth-log",
  "/api/user-question-flow-status",
]);

/**
 * Should this request be logged only if it fails?
 *
 * Prefix matching is deliberate: `/api/user-question-flow-status/<flow-id>` is the
 * real shape, so the flow id must not have to be enumerated.
 *
 * @param {string} pathname
 * @param {ReadonlyArray<string>} [routes]
 * @returns {boolean}
 */
function shouldLogOnlyOnFailure(pathname, routes = LOG_ONLY_ON_FAILURE_ROUTES) {
  if (typeof pathname !== "string" || !pathname) {
    return false;
  }
  return routes.some((route) => pathname.startsWith(route));
}

module.exports = {
  LOG_ONLY_ON_FAILURE_ROUTES,
  shouldLogOnlyOnFailure,
};
