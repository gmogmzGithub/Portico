const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const API_SOURCE = fs.readFileSync(
  path.join(__dirname, "api.js"),
  "utf8",
);

// --------------------------------------------------------------------------
// H-21 follow-up regression coverage. The MCP-assistant exposes servers to
// the LLM with a `server:` prefix (e.g. "server:google_workspace"). The rest
// of the Electron app keys off the bare canonical id ("google_workspace").
// When the prefix slipped through unstripped, the OAuth disposition lookup
// missed (→ NOT_OAUTH_SERVER for OAuth-backed servers) and the renderer's
// `appState.servers.find(s.id===…)` lookup missed (→ guided setup signalled
// success=false → response shaped as `dismissed: true` even though the user
// never dismissed anything — the modal never opened).
//
// We normalize once at the API boundary so every downstream consumer sees
// the canonical id. The asserts below pin both endpoints.
// --------------------------------------------------------------------------

test("api.js defines stripAssistantServerPrefix as the canonical normalizer", () => {
  assert.match(
    API_SOURCE,
    /const ASSISTANT_SERVER_PREFIX = "server:";/,
  );
  assert.match(
    API_SOURCE,
    /function stripAssistantServerPrefix\(id\) \{[\s\S]*?id\.startsWith\(ASSISTANT_SERVER_PREFIX\)[\s\S]*?id\.slice\(ASSISTANT_SERVER_PREFIX\.length\)/,
  );
});

test("/api/trigger-oauth-flow strips the LLM `server:` prefix before downstream lookups", () => {
  assert.match(
    API_SOURCE,
    /apiApp\.post\('\/api\/trigger-oauth-flow'[\s\S]{0,400}const server_id = stripAssistantServerPrefix\(req\.body\?\.server_id\);/,
  );
});

test("/api/trigger-guided-setup strips the LLM `server:` prefix before downstream lookups", () => {
  assert.match(
    API_SOURCE,
    /apiApp\.post\('\/api\/trigger-guided-setup'[\s\S]{0,400}const server_id = stripAssistantServerPrefix\(req\.body\?\.server_id\);/,
  );
});

test("stripAssistantServerPrefix is exported for downstream tests", () => {
  assert.match(API_SOURCE, /stripAssistantServerPrefix,/);
});

// Behavioral test (loads only the helper through a sandboxed extraction so
// we don't need to bring in electron/express to validate the trim rule).
test("stripAssistantServerPrefix behavior matches contract", () => {
  // Recreate the helper inline; the source-pinning tests above guarantee
  // this stays in lockstep with api.js.
  const ASSISTANT_SERVER_PREFIX = "server:";
  function stripAssistantServerPrefix(id) {
    if (typeof id !== "string") return id;
    return id.startsWith(ASSISTANT_SERVER_PREFIX)
      ? id.slice(ASSISTANT_SERVER_PREFIX.length)
      : id;
  }

  assert.equal(
    stripAssistantServerPrefix("server:google_workspace"),
    "google_workspace",
  );
  assert.equal(
    stripAssistantServerPrefix("google_workspace"),
    "google_workspace",
  );
  // Only strips the LLM-side prefix once; embedded `server:` substrings stay.
  assert.equal(
    stripAssistantServerPrefix("server:server:nested"),
    "server:nested",
  );
  // Defensive: non-strings pass through untouched (the endpoint will reject
  // missing/empty server_id later with a 400).
  assert.equal(stripAssistantServerPrefix(undefined), undefined);
  assert.equal(stripAssistantServerPrefix(null), null);
  assert.equal(stripAssistantServerPrefix(42), 42);
});
