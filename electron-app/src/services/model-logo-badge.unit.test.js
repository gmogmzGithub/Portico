// Item 3 (Batch 8): the three native modals must render the same animated model
// logo as the inline chat (base model when the chat is an agent), with a
// transparent background. These tests exercise the shared badge module
// (model-logo-badge.js) that ports the OWUI motion + animated marks to vanilla JS.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const badge = require(
  path.join(__dirname, "..", "renderer", "components", "model-logo-badge.js"),
);

const repoRoot = path.join(__dirname, "..", "..", "..");
const readRepo = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

test("resolveMotionKind maps celestial and brand families like the inline logo", () => {
  const { resolveMotionKind } = badge;
  assert.equal(resolveMotionKind({ celestialIdentity: "sol" }), "sol");
  assert.equal(resolveMotionKind({ celestialIdentity: "terra" }), "terra");
  assert.equal(resolveMotionKind({ celestialIdentity: "luna" }), "luna");
  assert.equal(resolveMotionKind({ brandFamily: "atlas" }), "atlas");
  assert.equal(resolveMotionKind({ brandFamily: "google" }), "gemini");
  assert.equal(resolveMotionKind({ brandFamily: "openai" }), "gpt");
  assert.equal(resolveMotionKind({ brandFamily: "other" }), "other");
  assert.equal(resolveMotionKind({ isLocal: true, brandFamily: "atlas" }), "local");
  // celestial wins over brand family.
  assert.equal(resolveMotionKind({ celestialIdentity: "sol", brandFamily: "openai" }), "sol");
  assert.equal(resolveMotionKind(null), "other");
});

test("getAtlasTier detects opus/haiku, defaulting to sonnet", () => {
  const { getAtlasTier } = badge;
  assert.equal(getAtlasTier("atlas-opus-4-8 Atlas Opus"), "opus");
  assert.equal(getAtlasTier("atlas-haiku-4-5"), "haiku");
  assert.equal(getAtlasTier("atlas-sonnet-5"), "sonnet");
  assert.equal(getAtlasTier(""), "sonnet");
});

test("getMotionStyle is deterministic per seed and emits the model-logo CSS variables", () => {
  const { getMotionStyle } = badge;
  const a = getMotionStyle("chat-1", "atlas", "sonnet");
  const b = getMotionStyle("chat-1", "atlas", "sonnet");
  assert.equal(a, b); // deterministic
  assert.match(a, /--model-logo-breathe-duration:/);
  assert.match(a, /--model-logo-spin-duration:/);
  assert.match(a, /--model-logo-atlas-ray-peak:/);
  // Different seed → different rhythm.
  assert.notEqual(getMotionStyle("chat-2", "atlas", "sonnet"), a);
});

test("buildAtlasMark emits an animated Atlas SVG with unique clip ids", () => {
  const { buildAtlasMark } = badge;
  const svg = buildAtlasMark("opus", "chat-1");
  assert.match(svg, /animated-atlas-mark animated-atlas-mark--opus/);
  assert.match(svg, /atlas-core/);
  assert.match(svg, /atlas-ray--1/);
  // clip ids are namespaced by the uid so two badges don't collide.
  assert.match(svg, /atlas-ray-clip-chat-1-0/);
  const other = buildAtlasMark("sonnet", "chat-2");
  assert.match(other, /atlas-ray-clip-chat-2-0/);
});

test("buildTerraMark emits an animated Terra sphere with two panning copies", () => {
  const { buildTerraMark } = badge;
  const svg = buildTerraMark("chat-1");
  assert.match(svg, /animated-terra-mark/);
  assert.match(svg, /animated-terra-ocean/);
  // Two continent copies (offset 0 and 100) make the sphere read as rotating.
  assert.equal((svg.match(/animated-terra-continent-copy/g) || []).length, 2);
  assert.match(svg, /translate\(0 0\)/);
  assert.match(svg, /translate\(100 0\)/);
});

function fakeBadge() {
  return { innerHTML: "", classList: { removed: [], remove() {} } };
}

test("render draws an always-animated motion wrapper for a Atlas agent (no image needed)", () => {
  const el = fakeBadge();
  badge.render(el, { brandFamily: "atlas", logoModelId: "atlas-sonnet-5", logoName: "Atlas Sonnet 5" }, { seed: "c1" });
  assert.match(el.innerHTML, /assistant-model-logo-motion assistant-model-logo-motion--atlas is-streaming/);
  assert.match(el.innerHTML, /data-model-logo-streaming="true"/);
  assert.match(el.innerHTML, /animated-atlas-mark/);
  // Atlas uses the animated SVG, not the profile image.
  assert.doesNotMatch(el.innerHTML, /<img/);
});

test("render uses the celestial image with the celestial-logo class for sol", () => {
  const el = fakeBadge();
  badge.render(el, {
    celestialIdentity: "sol",
    logoModelId: "gpt-5.6-sol",
    logoDataUrl: "data:image/png;base64,AAAA",
  }, { seed: "c1" });
  assert.match(el.innerHTML, /assistant-model-logo-motion--sol/);
  assert.match(el.innerHTML, /<img src="data:image\/png;base64,AAAA"[^>]*class="model-logo-badge-mark celestial-model-logo"/);
});

test("render applies the dark badge only for generic (non-celestial) OpenAI", () => {
  const dark = fakeBadge();
  badge.render(dark, { brandFamily: "openai", needsDarkBadge: true, logoDataUrl: "data:x" }, { seed: "c1" });
  assert.match(dark.innerHTML, /model-logo-badge--dark/);

  const transparent = fakeBadge();
  badge.render(transparent, { brandFamily: "atlas", logoModelId: "atlas-sonnet-5" }, { seed: "c1" });
  // Atlas (and every non-dark case) has a transparent badge — no dark modifier.
  assert.doesNotMatch(transparent.innerHTML, /model-logo-badge--dark/);
});

test("render falls back to initials when there is no logo image and no animated mark", () => {
  const el = fakeBadge();
  badge.render(el, { brandFamily: "other", fallbackText: "AI" }, { seed: "c1" });
  assert.match(el.innerHTML, /model-logo-badge-fallback">AI</);
});

test("render escapes fallback text and tolerates a missing element", () => {
  const el = fakeBadge();
  badge.render(el, { brandFamily: "other", fallbackText: "<b>x</b>" }, { seed: "c1" });
  assert.match(el.innerHTML, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotThrow(() => badge.render(null, { brandFamily: "atlas" }));
});

test("native input modals wire the animated badge + resolve the base model", () => {
  const MODALS = [
    "electron-app/src/renderer/components/sensitive-info-modal.js",
    "electron-app/src/renderer/components/chat-workspace-consent-modal.js",
  ];
  for (const rel of MODALS) {
    const src = readRepo(rel);
    // Renders through the shared animated badge.
    assert.match(src, /window\.renderModelLogoBadge\(/, `${rel} calls renderModelLogoBadge`);
    // Resolves the LOGO from the base model when the chat is an agent.
    assert.match(src, /if \(baseModelId\) \{[\s\S]*logoModelId = baseModelId/s, `${rel} resolves base model`);
    // Branding is computed from the base model id/name (not the agent's).
    assert.match(
      src,
      /getBrandFamily\(\{ displayName: logoName, modelId: logoModelId/,
      `${rel} brands from base model`,
    );
  }
});

test("both host HTML files load the badge module + stylesheet", () => {
  for (const rel of [
    "electron-app/src/renderer/views/index.html",
    "electron-app/src/renderer/views/conversation-window.html",
  ]) {
    const html = readRepo(rel);
    assert.match(html, /renderer\/components\/model-logo-badge\.css/, `${rel} links the badge CSS`);
    const scriptIndex = html.indexOf("renderer/components/model-logo-badge.js");
    assert.ok(scriptIndex >= 0, `${rel} includes the badge script`);
  }
});
