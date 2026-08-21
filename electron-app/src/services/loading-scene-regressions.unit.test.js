const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

test("loading screen renders the vector Jupiter scene instead of the logo", () => {
  const loadingHtml = readRepoFile("electron-app/src/renderer/views/loading.html");

  assert.match(loadingHtml, /<div class="planet-stage" aria-hidden="true">/);
  assert.match(loadingHtml, /<div class="starfield" aria-hidden="true">/);
  assert.match(loadingHtml, /class="jupiter-drift"/);
  assert.match(loadingHtml, /class="jupiter-ring jupiter-ring--back"/);
  assert.match(loadingHtml, /class="jupiter-ring jupiter-ring--front"/);
  assert.doesNotMatch(loadingHtml, /class="logo"/);
  assert.doesNotMatch(loadingHtml, /icon-light\.png/);
  // SVG filters rasterize per frame; the scene must stay gradient/clip-only.
  assert.doesNotMatch(loadingHtml, /<filter[\s>]/);
});

test("cosmic scene animations are transform/opacity keyframes gated behind reduced motion", () => {
  const loadingHtml = readRepoFile("electron-app/src/renderer/views/loading.html");

  assert.match(
    loadingHtml,
    /@keyframes jupiter-drift\s*\{\s*from\s*\{\s*transform: translateX\(0\);\s*\}\s*to\s*\{\s*transform: translateX\(-384px\);\s*\}\s*\}/,
  );
  assert.match(loadingHtml, /@keyframes star-twinkle\s*\{[^}]*opacity/);
  assert.match(
    loadingHtml,
    /@keyframes jupiter-orbit-spin\s*\{\s*from\s*\{\s*transform: rotate\(-12deg\) scale\(1, 0\.22\) rotate\(0deg\);\s*\}\s*to\s*\{\s*transform: rotate\(-12deg\) scale\(1, 0\.22\) rotate\(360deg\);\s*\}\s*\}/,
  );
  assert.match(loadingHtml, /@keyframes jupiter-orbit-front\s*\{[^}]*opacity/);
  assert.match(loadingHtml, /@keyframes jupiter-orbit-back\s*\{[^}]*opacity/);
  // Grains must be HTML overlay layers (SVG-internal transform animations repaint
  // on the main thread), and every front grain needs a synchronized back twin.
  assert.match(loadingHtml, /\.ring-orbit-group\s*\{[^}]*will-change: transform;/);
  const frontGrains = loadingHtml.match(/class="ring-grain ring-grain--front"/g) || [];
  const backGrains = loadingHtml.match(/class="ring-grain ring-grain--back"/g) || [];
  assert.ok(frontGrains.length > 0);
  assert.equal(frontGrains.length, backGrains.length);
  assert.match(
    loadingHtml,
    /@keyframes jupiter-glow\s*\{\s*0%,\s*100%\s*\{\s*opacity: 0\.65;\s*transform: scale\(0\.96\);\s*\}\s*50%\s*\{\s*opacity: 1;\s*transform: scale\(1\.05\);\s*\}\s*\}/,
  );
  assert.match(
    loadingHtml,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.jupiter-drift,\s*\.starfield \.tw,\s*\.starfield \.sp-core\s*\{\s*animation: none;/,
  );
  // The glow pseudo-elements must be stilled too (rule lives inside the same media block).
  assert.match(
    loadingHtml,
    /\.planet-stage::before,\s*\.planet-stage::after\s*\{\s*animation: none;/,
  );
  // Orbiting grains are hidden under reduced motion (frozen ones would stack mid-orbit).
  assert.match(
    loadingHtml,
    /\.ring-orbit-group,\s*\.ring-grain\s*\{\s*animation: none;\s*\}\s*\.ring-orbits\s*\{\s*opacity: 0;/,
  );
  // Error states reclaim vertical room by shrinking the planet stage.
  assert.match(
    loadingHtml,
    /body:has\(#recovery-buttons\.visible\) \.planet-stage\s*\{\s*height: 120px;/,
  );
});

test("starfield stays inert and behind the interactive panels", () => {
  const loadingHtml = readRepoFile("electron-app/src/renderer/views/loading.html");

  assert.match(
    loadingHtml,
    /\.starfield\s*\{[^}]*position: fixed;[^}]*z-index: 0;[^}]*pointer-events: none;/,
  );
  assert.match(loadingHtml, /\.main-container\s*\{[^}]*z-index: 1;/);
  // The copy toast must outrank .main-container's stacking context or it paints underneath.
  assert.match(loadingHtml, /\.copy-feedback\s*\{[^}]*z-index: 2;/);
});
