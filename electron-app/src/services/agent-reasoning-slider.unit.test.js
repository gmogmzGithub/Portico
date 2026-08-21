// Reasoning-effort slider contract: OWUI replica component + agents.js wiring.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const slider = require("../renderer/components/agent-reasoning-slider");

const sliderSource = fs.readFileSync(
  path.join(__dirname, "..", "renderer", "components", "agent-reasoning-slider.js"),
  "utf8",
);
const agentsSource = fs.readFileSync(
  path.join(__dirname, "..", "renderer", "components", "agents.js"),
  "utf8",
);
const styles = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
const indexHtml = fs.readFileSync(
  path.join(__dirname, "..", "renderer", "views", "index.html"),
  "utf8",
);

test("module exposes the OWUI label map and field builder", () => {
  assert.equal(slider.EFFORT_LABELS[""], "Default");
  assert.equal(slider.EFFORT_LABELS.xhigh, "Extra High");
  assert.equal(slider.EFFORT_LABELS.max, "Max");
  const html = slider.buildFieldHtml("medium");
  assert.match(html, /data-agent-reasoning-slider/);
  assert.match(html, /data-current-value="medium"/);
});

test("hidden reasoning_effort input preserves the FormData contract", () => {
  // The mounted control writes a hidden input named reasoning_effort ("" =
  // model default) and blanks it when the field is disabled.
  assert.match(sliderSource, /<input type="hidden" name="reasoning_effort"/);
  assert.match(sliderSource, /const next = fieldState\.disabled \? "" : currentValue;/);
  // agents.js reads it via FormData (readAgentForm) — the form field remains.
  assert.match(agentsSource, /agentReasoningSliderApi\.buildFieldHtml\(/);
  assert.match(agentsSource, /agentReasoningSliderApi\.mount\(/);
  assert.doesNotMatch(agentsSource, /buildReasoningEffortSelect/);
});

test("Default is the leading stop and max-effort excludes it", () => {
  assert.match(sliderSource, /return \["", \.\.\.\(Array\.isArray\(fieldState\.options\)/);
  // Purple theme only at the last REAL option.
  assert.match(
    sliderSource,
    /return opts\.length > 0 && currentValue === opts\[opts\.length - 1\];/,
  );
});

test("OWUI visual spec is ported exactly", () => {
  // Gradient fill + drift animation + particle stream keyframes.
  assert.match(styles, /linear-gradient\(110deg, #7758ff 0%, #298df6 42%, #19c6e8 72%, #6be0d0 100%\)/);
  assert.match(styles, /reasoning-gradient-drift 3\.2s ease-in-out infinite alternate/);
  assert.match(styles, /@keyframes reasoning-particle-stream/);
  assert.match(styles, /translateX\(-17rem\) scale\(1\.18\)/);
  // 2.45rem thumb + focus ring.
  assert.match(styles, /\.reasoning-effort-slider::-webkit-slider-thumb \{[^}]*width: 2\.45rem;/s);
  assert.match(styles, /0 0 0 3px rgba\(37, 141, 244, 0\.18\)/);
  // Reduced motion kills the animations.
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.reasoning-effort-slider-fill/s);
  // Particle speed ramps with effort (1.45 − ratio·0.83).
  assert.match(sliderSource, /1\.45 - ratio \* 0\.83/);
  // 7 particle spans.
  assert.match(sliderSource, /"<span><\/span>"\.repeat\(7\)/);
});

test("slider is detached alongside the pickers and model picker", () => {
  const detachCount = (agentsSource.match(/agent-reasoning-slider-detach/g) || []).length;
  assert.ok(detachCount >= 2, "detach dispatched from both closeModal and teardownAgentEditor");
  assert.match(sliderSource, /agent-reasoning-slider-detach/);
});

test("component script loads before agents.js", () => {
  const sliderIdx = indexHtml.indexOf("agent-reasoning-slider.js");
  const agentsIdx = indexHtml.indexOf('renderer/components/agents.js');
  assert.ok(sliderIdx > 0 && sliderIdx < agentsIdx);
});
