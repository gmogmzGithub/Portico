// PORTICO-323 (#4): a payload download refused by an HTTP layer used to reach the
// user as raw downloader text ("curl: (56) The requested URL returned
// <REDACTED>: 403"), which names a transport exit code rather than the cause
// and offers no next step. These tests pin the actionable replacement.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractDownloadHttpStatus,
  errorIndicatesBlockedDownload,
  actionableDownloadFailureMessage,
} = require("./update-download-failure");

// The exact string the reporting user hit, after log redaction replaced the
// word "error". The trailing status is the only surviving signal.
const REDACTED_403 =
  "Failed to download update payload after 3 attempts: " +
  "curl: (56) The requested URL returned <REDACTED>: 403";

const CANONICAL_403 =
  "Failed to download update payload after 3 attempts: HTTP 403 " +
  "(curl: (56) The requested URL returned <REDACTED>: 403)";

test("extracts the HTTP status from redacted curl download text", () => {
  assert.equal(extractDownloadHttpStatus(REDACTED_403), 403);
});

test("extracts the HTTP status from the canonical prepare-script marker", () => {
  assert.equal(extractDownloadHttpStatus(CANONICAL_403), 403);
});

test("extracts the HTTP status from wget download text", () => {
  assert.equal(
    extractDownloadHttpStatus(
      "Failed to download update payload: ERROR 403: Forbidden.",
    ),
    403,
  );
});

test("reads the status from an Error object and its cause", () => {
  const error = new Error(CANONICAL_403);
  assert.equal(extractDownloadHttpStatus(error), 403);
  assert.equal(errorIndicatesBlockedDownload(error), true);
});

test("a refused download becomes actionable guidance naming the status", () => {
  const message = actionableDownloadFailureMessage(REDACTED_403);
  assert.match(message, /HTTP 403/);
  assert.match(message, /VPN/i);
  assert.match(message, /#help-portico/);
  // The raw transport noise must not survive into the user-facing text.
  assert.doesNotMatch(message, /curl/i);
  assert.doesNotMatch(message, /\(56\)/);
});

test("404 is reported as a release problem, not a network problem", () => {
  const message = actionableDownloadFailureMessage(
    "Failed to download update payload: HTTP 404",
  );
  assert.match(message, /HTTP 404/);
  assert.match(message, /wasn't found/i);
  // Must not tell the user to fix their network for a server-side problem.
  assert.doesNotMatch(message, /VPN/i);
});

test("5xx is reported as temporary with a retry suggestion", () => {
  const message = actionableDownloadFailureMessage(
    "Failed to download update payload: HTTP 503",
  );
  assert.match(message, /HTTP 503/);
  assert.match(message, /temporary/i);
});

test("download failures without an HTTP status are left unchanged", () => {
  // The transport-only failure this same user hit in July must keep its text.
  assert.equal(
    actionableDownloadFailureMessage(
      "Failed to download update payload after 3 attempts: " +
        "curl: (56) Recv failure: Connection reset by peer",
    ),
    null,
  );
  assert.equal(extractDownloadHttpStatus("some unrelated failure"), null);
  assert.equal(actionableDownloadFailureMessage(null), null);
});

test("non-download messages containing numbers are never misread as a status", () => {
  assert.equal(
    extractDownloadHttpStatus("prepare script failed with exit code 404"),
    null,
  );
  assert.equal(errorIndicatesBlockedDownload("returned 403"), false);
});
