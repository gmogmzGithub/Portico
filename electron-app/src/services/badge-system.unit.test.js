// Unit tests for the unified badge system (Batch 4): one token set + one visual
// for Core/User/Host/Marketplace (and the other badge families) app-wide.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const styles = fs.readFileSync(
  path.join(__dirname, "..", "styles.css"),
  "utf8",
);

// The source-badge categories that must read from CSS variables (no hardcoded
// per-theme hex in the variant rules).
const TOKEN_CATEGORIES = [
  "core",
  "user",
  "host",
  "marketplace",
  "version",
  "author",
  "official",
  "installed",
  "provider",
];

test("every badge category defines bg + text tokens in both themes", () => {
  // Dark defaults live in :root; light overrides in [data-theme=\"light\"].
  const rootBlock = styles.slice(
    styles.indexOf(":root"),
    styles.indexOf("[data-theme=\"light\"]"),
  );
  for (const cat of TOKEN_CATEGORIES) {
    assert.match(
      styles,
      new RegExp(`--badge-${cat}-bg:`),
      `missing --badge-${cat}-bg token`,
    );
    assert.match(
      styles,
      new RegExp(`--badge-${cat}-text:`),
      `missing --badge-${cat}-text token`,
    );
  }
});

test("core/user/host/marketplace variant rules are token-driven (no hardcoded hex)", () => {
  const variants = [
    ".mcp-card-badge.badge-core",
    ".mcp-card-badge.badge-user",
    ".mcp-card-badge.badge-host",
    ".mcp-card-badge.badge-marketplace",
  ];
  for (const sel of variants) {
    const idx = styles.indexOf(sel + " {");
    assert.notEqual(idx, -1, `missing rule for ${sel}`);
    const block = styles.slice(idx, styles.indexOf("}", idx));
    assert.match(block, /var\(--badge-/, `${sel} should use a token`);
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,6}/, `${sel} should not hardcode hex`);
    assert.doesNotMatch(block, /rgba?\(/, `${sel} should not hardcode rgb`);
  }
});

test("legacy per-theme overrides for source badges were removed (single source of truth)", () => {
  // These light-theme overrides used to hardcode colors; they must be gone now
  // that the tokens carry the light values.
  assert.doesNotMatch(
    styles,
    /\[data-theme="light"\] \.mcp-card-badge\.badge-marketplace \{/,
  );
  assert.doesNotMatch(
    styles,
    /\[data-theme="light"\] \.mcp-card-badge\.badge-version \{/,
  );
  assert.doesNotMatch(
    styles,
    /\[data-theme="light"\] \.mcp-card-badge\.badge-author \{/,
  );
});

test(".deployment-badge shares the canonical badge geometry", () => {
  const idx = styles.indexOf(".deployment-badge {");
  const block = styles.slice(idx, styles.indexOf("}", idx));
  // Same pill geometry as .mcp-card-badge (0.1875rem radius, 0.625rem font).
  assert.match(block, /border-radius: 0\.1875rem/);
  assert.match(block, /font-size: 0\.625rem/);
  assert.match(block, /text-transform: uppercase/);
});

test("published / unpublished pills are token-driven", () => {
  const pubIdx = styles.indexOf(".mcp-card-badge.badge-published {");
  assert.notEqual(pubIdx, -1, "shared badge-published variant exists");
  const pub = styles.slice(pubIdx, styles.indexOf("}", pubIdx));
  assert.match(pub, /var\(--badge-published-bg\)/);
  assert.match(pub, /var\(--badge-published-text\)/);

  const unpubIdx = styles.indexOf(".mcp-card-badge.badge-unpublished {");
  assert.notEqual(unpubIdx, -1, "shared badge-unpublished variant exists");
  const unpub = styles.slice(unpubIdx, styles.indexOf("}", unpubIdx));
  assert.match(unpub, /var\(--badge-unpublished-bg\)/);
  assert.match(unpub, /var\(--badge-unpublished-text\)/);

  // The legacy one-off pill classes are gone — one chip family everywhere.
  assert.doesNotMatch(styles, /\n\.agent-published\b/);
  assert.doesNotMatch(styles, /\n\.agent-installed\b/);
  assert.doesNotMatch(styles, /\n\.agent-unpublished\b/);
});

test("badges keep one size everywhere and update tokens are themed", () => {
  // The tab density override must not shrink badges anymore: cards, detail
  // pages, and modals all render the base .mcp-card-badge size.
  assert.doesNotMatch(styles, /#control-tab \.mcp-card-badge,/);

  // Light theme defines its own update-badge pair (the dark orange tint is
  // unreadable on light surfaces).
  const lightIdx = styles.indexOf('[data-theme="light"]');
  assert.notEqual(lightIdx, -1);
  const lightBlock = styles.slice(lightIdx, styles.indexOf("\n}", lightIdx));
  assert.match(lightBlock, /--badge-updates-bg:/);
  assert.match(lightBlock, /--badge-updates-text:/);
});
