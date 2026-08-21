const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveCanonicalMarketplaceUrl,
} = require("../renderer/components/marketplace-source-url");

test("deriveCanonicalMarketplaceUrl returns roundtrippable GitHub repo URLs", () => {
  assert.equal(
    deriveCanonicalMarketplaceUrl({
      type: "github",
      repoUrl: "https://github.com/acme/skills",
    }),
    "https://github.com/acme/skills",
  );

  assert.equal(
    deriveCanonicalMarketplaceUrl({
      type: "github",
      repoUrl: "https://github.com/acme/skills",
      ref: "release/2026 Q1",
    }),
    "https://github.com/acme/skills",
  );
});

test("deriveCanonicalMarketplaceUrl returns roundtrippable GitLab repo URLs", () => {
  assert.equal(
    deriveCanonicalMarketplaceUrl({
      type: "gitlab",
      repoUrl: "https://example.invalid/acme/skills.git",
    }),
    "https://example.invalid/acme/skills/",
  );

  assert.equal(
    deriveCanonicalMarketplaceUrl({
      type: "gitlab",
      repoUrl: "https://example.invalid/acme/skills.git",
      ref: "release/2026 Q1",
    }),
    "https://example.invalid/acme/skills/",
  );
});

test("deriveCanonicalMarketplaceUrl passes through direct URLs and rejects unsupported sources", () => {
  assert.equal(
    deriveCanonicalMarketplaceUrl({
      type: "url",
      url: "https://example.com/path/to/marketplace.json",
    }),
    "https://example.com/path/to/marketplace.json",
  );

  assert.equal(
    deriveCanonicalMarketplaceUrl({
      type: "github",
      repo: "acme/skills",
      ref: "main",
    }),
    "https://github.com/acme/skills",
  );

  assert.equal(
    deriveCanonicalMarketplaceUrl({
      type: "gitlab",
      host: "example.invalid",
      projectPath: "acme/skills",
    }),
    "https://example.invalid/acme/skills/",
  );

  assert.equal(deriveCanonicalMarketplaceUrl({ type: "unsupported" }), null);
  assert.equal(deriveCanonicalMarketplaceUrl(null), null);
});
