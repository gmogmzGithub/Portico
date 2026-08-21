const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const stylesPath = path.join(repoRoot, "electron-app", "src", "styles.css");
const componentPath = path.join(
  repoRoot,
  "electron-app",
  "src",
  "renderer",
  "components",
  "cost-dashboard.js",
);

test("cost dashboard negative savings uses a darker light-mode warning token", () => {
  const stylesSource = fs.readFileSync(stylesPath, "utf8");

  assert.match(
    stylesSource,
    /--cost-dashboard-warning-color:\s*#fbbf24;/,
    "dark/default cost dashboard warning color should preserve the existing amber tone",
  );
  assert.match(
    stylesSource,
    /\[data-theme="light"\]\s+#cost-dashboard-view\s*\{[^}]*--cost-dashboard-warning-color:\s*#b45309;[^}]*--cost-dashboard-warning-border-color:\s*rgba\(180,\s*83,\s*9,\s*0\.28\);/s,
    "light-mode cost dashboard should define a darker orange warning token and matching border tone",
  );
  assert.match(
    stylesSource,
    /\.cost-dashboard-metric\.tone-warning\s*\{[^}]*border-color:\s*var\(--cost-dashboard-warning-border-color\);/s,
    "summary negative-savings metric border should use the shared warning border token",
  );
  assert.match(
    stylesSource,
    /\.cost-dashboard-metric-value\.value-warning\s*\{[^}]*color:\s*var\(--cost-dashboard-warning-color\);/s,
    "summary negative-savings value should use the shared warning color token",
  );
  assert.match(
    stylesSource,
    /\.cost-dashboard-metric-meta\.meta-warning\s*\{[^}]*color:\s*var\(--cost-dashboard-warning-color\);/s,
    "summary negative-savings meta should use the shared warning color token",
  );
  assert.match(
    stylesSource,
    /\.cost-dashboard-chart-tooltip-row strong\.warning\s*\{[^}]*color:\s*var\(--cost-dashboard-warning-color\);/s,
    "chart tooltip negative-savings text should use the shared warning color token",
  );
  assert.match(
    stylesSource,
    /\.cost-dashboard-savings-cell\.negative\s*\{[^}]*color:\s*var\(--cost-dashboard-warning-color\);/s,
    "table negative-savings amount should use the shared warning color token",
  );
  assert.match(
    stylesSource,
    /\.cost-dashboard-savings-rate\.negative\s*\{[^}]*color:\s*var\(--cost-dashboard-warning-color\);/s,
    "table negative-savings rate should use the shared warning color token",
  );
});

test("cost dashboard model breakdown routes negative savings through warning styling", () => {
  const componentSource = fs.readFileSync(componentPath, "utf8");
  const stylesSource = fs.readFileSync(stylesPath, "utf8");

  assert.match(
    componentSource,
    /const savingsCardTone = getSavingsTone\(model\.netCacheSavings\);/,
    "model cards should derive their card tone from the savings amount",
  );
  assert.match(
    componentSource,
    /const savingsValueTone = model\.netCacheSavings >= 0 \? "savings" : "warning";/,
    "model cards should switch negative savings text to warning tone",
  );
  assert.match(
    componentSource,
    /cost-dashboard-model-stat tone-\$\{escapeHtml\(savingsCardTone\)\} has-popover/,
    "model cards should apply the derived savings card tone to the container",
  );
  assert.match(
    componentSource,
    /cost-dashboard-model-stat-value \$\{escapeHtml\(savingsValueTone\)\}/,
    "model cards should apply the derived warning class to the value",
  );
  assert.match(
    componentSource,
    /cost-dashboard-model-stat-meta \$\{escapeHtml\(savingsValueTone\)\}/,
    "model cards should apply the derived warning class to the meta copy",
  );
  assert.match(
    stylesSource,
    /\.cost-dashboard-model-stat\.tone-warning\s*\{[^}]*background:\s*var\(--cost-dashboard-warning-surface\);[^}]*border-color:\s*var\(--cost-dashboard-warning-surface-border\);/s,
    "model cards should define a dedicated warning surface for negative savings",
  );
  assert.match(
    stylesSource,
    /\.cost-dashboard-model-stat-value\.warning\s*\{[^}]*color:\s*var\(--cost-dashboard-warning-color\);/s,
    "model card negative-savings value should use the shared warning token",
  );
  assert.match(
    stylesSource,
    /\.cost-dashboard-model-stat-meta\.warning\s*\{[^}]*color:\s*var\(--cost-dashboard-warning-color\);/s,
    "model card negative-savings meta should use the shared warning token",
  );
});
