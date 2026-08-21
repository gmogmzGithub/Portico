// PORTICO PATCH (Round 4 / Issue 2d): structural smoke tests for the
// Settings → Allowlists page + its API client.
//
// We can't fully render Svelte under node:test, so these tests pin
// the structural contract (selectors, REST URLs, error handling)
// that the rest of the system relies on.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..");
const SETTINGS_PATH = path.join(
  REPO_ROOT,
  "src",
  "patches",
  "frontend",
  "src",
  "lib",
  "components",
  "chat",
  "Settings",
  "Allowlists.svelte",
);
const API_CLIENT_PATH = path.join(
  REPO_ROOT,
  "src",
  "patches",
  "frontend",
  "src",
  "lib",
  "apis",
  "toolAllowlist.ts",
);

const settingsSource = fs.readFileSync(SETTINGS_PATH, "utf8");
const apiSource = fs.readFileSync(API_CLIENT_PATH, "utf8");

// ---------------------------------------------------------------------------
// API client structural invariants
// ---------------------------------------------------------------------------

test("toolAllowlist client targets the canonical REST routes", () => {
  // The router declared exactly these paths; if a future refactor
  // drifts (e.g. ``/allowlist`` vs ``/allowlists``) the chip flow
  // and Settings page break together.
  assert.match(apiSource, /\/api\/v1\/utils\/allowlists['"`]/);
  assert.match(
    apiSource,
    /\/api\/v1\/utils\/allowlists\/entries['"`]/,
  );
  assert.match(
    apiSource,
    /\/api\/v1\/utils\/allowlists\/entries\/\$\{encodeURIComponent\(entryId\)\}/,
  );
  assert.match(
    apiSource,
    /\/api\/v1\/utils\/allowlists\/master-toggle/,
  );
});

test("toolAllowlist client always sends the bearer token", () => {
  // Every helper goes through ``authedJsonFetch`` so a future
  // helper added without auth header is the kind of regression
  // we want to catch in a smoke test.
  assert.match(apiSource, /Authorization:\s*`Bearer \$\{token\}`/);
  // No fetch() call outside the helper — search for raw fetch
  // outside of authedJsonFetch.
  const rawFetchMatches = (apiSource.match(/await fetch\(/g) ?? []).length;
  assert.equal(
    rawFetchMatches,
    1,
    "expected exactly one raw fetch() inside the auth helper; helpers must funnel through authedJsonFetch",
  );
});

test("toolAllowlist client provides an empty-state factory", () => {
  // The Settings page falls back to ``emptyAllowlistFile()`` while
  // loading; if this drifts to a wrong shape the page renders the
  // 'undefined' as a header.
  assert.match(apiSource, /export const emptyAllowlistFile/);
  assert.match(apiSource, /master_disabled:\s*false/);
  assert.match(apiSource, /entries:\s*\[\]/);
});

test("toolAllowlist client encodes entry ids before interpolation", () => {
  // entry.id is a uuid hex today, but we still encode for defensive
  // safety — protects against a future opaque id format that contains
  // path-sensitive characters.
  assert.ok(
    apiSource.includes("encodeURIComponent(entryId)"),
    "entry id must be URI-encoded before being inserted into URLs",
  );
});

// ---------------------------------------------------------------------------
// Settings page structural invariants
// ---------------------------------------------------------------------------

test("Settings page exposes stable test selectors", () => {
  for (const selector of [
    "settings-allowlists",
    "allowlist-master-toggle",
    "allowlist-loading",
    "allowlist-empty",
    "allowlist-groups",
    "allowlist-group-header",
    "allowlist-entry",
    "allowlist-entry-toggle",
    "allowlist-entry-remove",
  ]) {
    assert.match(
      settingsSource,
      new RegExp(`data-test-id="${selector}"`),
      `missing data-test-id="${selector}"`,
    );
  }
});

test("Settings page master toggle inverts master_disabled semantics", () => {
  // The user-facing toggle reads as "Allowlists ENABLED" (i.e. the
  // OFF position is "master disabled"). The handler MUST invert the
  // checkbox value before posting to the backend, otherwise the
  // panic button becomes a footgun.
  assert.match(
    settingsSource,
    /setAllowlistMasterToggle\(token,\s*!checked\)/,
  );
});

test("Settings page provides a 5-second undo on entry deletion", () => {
  // The user explicitly requested "5s Undo" behavior in the round-4
  // requirements. Pin both the toast duration and the wrapping
  // timeout that COMMITS the delete after the undo window closes.
  assert.match(settingsSource, /duration:\s*5000/);
  // 5100 = 5000 + 100ms slack so the toast's onClick handler has
  // a chance to fire before we commit the delete.
  assert.match(settingsSource, /setTimeout\(/);
  assert.match(settingsSource, /5100/);
});

test("Settings page groups entries by mcp for legibility", () => {
  // The "group by MCP" pattern matches the chip-cluster grouping
  // (Round 4 / Issue 4) so the user's mental model is the same in
  // both places: actions belong to integrations.
  assert.match(settingsSource, /groupEntriesByMcp/);
  assert.match(settingsSource, /Map<string, ToolAllowlistEntry\[\]>/);
});

test("Settings page falls back to an empty-state message", () => {
  assert.match(settingsSource, /allowlist-empty/);
  assert.match(
    settingsSource,
    /No allowlist entries yet/i,
  );
});

// ---------------------------------------------------------------------------
// SettingsModal wiring — make sure the new tab actually shows up
// ---------------------------------------------------------------------------

const SETTINGS_MODAL_PATH = path.join(
  REPO_ROOT,
  "src",
  "patches",
  "frontend",
  "src",
  "lib",
  "components",
  "chat",
  "SettingsModal.svelte",
);
const settingsModalSource = fs.readFileSync(SETTINGS_MODAL_PATH, "utf8");

test("SettingsModal imports the Allowlists tab component", () => {
  assert.match(
    settingsModalSource,
    /import Allowlists from ['"]\.\/Settings\/Allowlists\.svelte['"]/,
  );
});

test("SettingsModal registers the Allowlists tab in visibleSettings", () => {
  // The tab id MUST be ``allowlists`` (kebab) so the existing
  // selectedTab type union and the conditional render block agree.
  // Pin both the id and a sample keyword so a refactor that moves
  // the keyword list elsewhere has to preserve the discoverability
  // contract.
  assert.match(settingsModalSource, /id:\s*['"]allowlists['"]/);
  assert.match(settingsModalSource, /title:\s*['"]Allowlists['"]/);
  assert.match(settingsModalSource, /['"]always allow['"]/i);
});

test("SettingsModal renders the Allowlists tab when selected", () => {
  // The conditional render block in the template MUST mount the
  // imported component when the user picks the tab. The bearer
  // token is forwarded from localStorage.token to keep the auth
  // model identical to the rest of OWUI's API clients.
  assert.match(
    settingsModalSource,
    /selectedTab\s*===\s*['"]allowlists['"]/,
  );
  assert.match(
    settingsModalSource,
    /<Allowlists\s+token=\{localStorage\.token\}\s*\/>/,
  );
});

test("SettingsModal does not break the existing tab union type", () => {
  // The selectedTab type union must include the new id so TS
  // doesn't reject the assignment. We grep for the literal type
  // alternation rather than the full type to keep the test robust
  // against whitespace changes.
  assert.match(
    settingsModalSource,
    /id:\s*['"]interface['"]\s*\|\s*['"]data_controls['"]\s*\|\s*['"]allowlists['"]/,
  );
});
