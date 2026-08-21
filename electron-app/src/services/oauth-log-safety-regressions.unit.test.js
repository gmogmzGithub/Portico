const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const loggerSource = fs.readFileSync(
  path.join(__dirname, "oauth-logger.js"),
  "utf8",
);

const rendererSources = [
  "../renderer/components/oauth-wizard-modal.js",
  "../renderer/components/oauth-modal-shared.js",
  "../renderer/screens/guided-setup/screen-oauth.js",
].map((relativePath) =>
  fs.readFileSync(path.join(__dirname, relativePath), "utf8"),
);

test("OAuth logger fully redacts query and structured state values", () => {
  assert.match(loggerSource, /\[\?&\]state=/);
  assert.match(loggerSource, /replacement: '\$1\[REDACTED\]'/);
  assert.doesNotMatch(loggerSource, /State parameters \(keep first 8 chars/);
});

test("OAuth renderers do not log authorization URLs or full status payloads", () => {
  for (const source of rendererSources) {
    assert.doesNotMatch(source, /authUrl\.substring/);
    assert.doesNotMatch(source, /reAuthReady\.authUrl\.substring/);
    assert.doesNotMatch(source, /JSON\.stringify\(oauthStatus/);
  }
});
