// ============================================================================
// Download-failure messaging for the update pipeline (PORTICO-323, failure mode 4).
//
// When the update payload request is refused by an HTTP layer, the user saw the
// raw downloader text, e.g.
//
//   Update preparation failed: Failed to download update payload after 3
//   attempts: curl: (56) The requested URL returned <REDACTED>: 403
//
// That is unactionable: it names a transport exit code, not the real cause, and
// gives no way forward. Reported repeatedly by one user whose machine received
// HTTP 403 on every attempt while the same artifact served fine elsewhere --
// i.e. a network/proxy restriction on that Mac, not a broken update.
//
// This helper turns a download failure carrying an HTTP status into a
// plain-language message with concrete next steps, mirroring the OrbStack
// treatment in orbstack-availability.js.
//
// Scope note: this is messaging only. Retry classification (a terminal 4xx is
// still retried because curl reports it behind transport exit code 56) and
// download telemetry (sanitized request IDs) are deliberately NOT changed here
// and remain tracked as follow-ups.
// ============================================================================

const SUPPORT_CHANNEL = "#help-portico";

// Statuses that mean "something refused this request", which in practice is a
// VPN / proxy / network-policy problem rather than a bad update.
const BLOCKED_STATUSES = new Set([401, 403, 407, 451]);
// Statuses that mean the server answered but the package is not there.
const NOT_FOUND_STATUSES = new Set([404, 410]);

function blockedDownloadMessage(status) {
  return (
    `Portico couldn't download the update because the request was ` +
    `refused (HTTP ${status}). This is almost always a VPN or network ` +
    `restriction on this Mac rather than a problem with the update itself. ` +
    `Connect to the Portico VPN and try again; if you're on a guest or ` +
    `restricted network, switch networks and retry. If it keeps failing, ` +
    `click the bug icon to collect debug info and share it in ${SUPPORT_CHANNEL}.`
  );
}

function notFoundDownloadMessage(status) {
  return (
    `Portico couldn't download the update because the update package ` +
    `wasn't found on the server (HTTP ${status}). Your Mac reached the server, ` +
    `so this is a problem with the release rather than your network. Please ` +
    `click the bug icon to collect debug info and report it in ` +
    `${SUPPORT_CHANNEL}.`
  );
}

function serverErrorDownloadMessage(status) {
  return (
    `Portico couldn't download the update because the download server ` +
    `returned an error (HTTP ${status}). This is usually temporary — wait a few ` +
    `minutes and try again. If it keeps failing, click the bug icon to collect ` +
    `debug info and share it in ${SUPPORT_CHANNEL}.`
  );
}

function messageTextFrom(error) {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  return [error.message, error.cause && error.cause.message]
    .filter(Boolean)
    .join(" ");
}

// Pull the HTTP status out of a download failure message.
//
// The preferred form is the canonical "HTTP <status>" that
// prepare-update-cloudsmith.sh now emits. The looser fallbacks cover raw
// downloader text, including log-redacted variants -- the redactor can replace
// the word "error" in `curl: (56) The requested URL returned error: 403`, but
// the trailing status code survives.
function extractDownloadHttpStatus(error) {
  const text = messageTextFrom(error);
  if (!text) {
    return null;
  }
  // Only classify failures that are actually about downloading the payload, so
  // an unrelated message containing a number can never be misread as a status.
  if (!/download/i.test(text)) {
    return null;
  }

  const patterns = [
    /\bHTTP\s+([1-5]\d{2})\b/i, // canonical marker from the prepare script
    /returned[^0-9]{0,20}?([1-5]\d{2})\b/i, // curl --fail text, redaction tolerant
    /\bERROR\s+([1-5]\d{2}):/i, // wget text
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const status = Number(match[1]);
      if (Number.isInteger(status) && status >= 400 && status <= 599) {
        return status;
      }
    }
  }
  return null;
}

function errorIndicatesBlockedDownload(error) {
  return extractDownloadHttpStatus(error) !== null;
}

// Return an actionable download-failure message when the failure carries an
// HTTP status; otherwise return null so callers keep their existing text.
function actionableDownloadFailureMessage(error) {
  const status = extractDownloadHttpStatus(error);
  if (status === null) {
    return null;
  }
  if (BLOCKED_STATUSES.has(status)) {
    return blockedDownloadMessage(status);
  }
  if (NOT_FOUND_STATUSES.has(status)) {
    return notFoundDownloadMessage(status);
  }
  if (status >= 500) {
    return serverErrorDownloadMessage(status);
  }
  // Any other 4xx: the request was rejected, and the blocked-download guidance
  // (network first, then report) is still the right next step.
  return blockedDownloadMessage(status);
}

module.exports = {
  extractDownloadHttpStatus,
  errorIndicatesBlockedDownload,
  actionableDownloadFailureMessage,
};
