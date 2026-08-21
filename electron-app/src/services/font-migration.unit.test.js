const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function readRepoBytes(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath));
}

test("Portico Sans replaces Urbanist across bundled UI surfaces", () => {
  const styles = readRepoFile("electron-app/src/styles.css");
  const loadingHtml = readRepoFile("electron-app/src/renderer/views/loading.html");
  const guidedSetupCss = readRepoFile("electron-app/src/renderer/views/guided-setup.css");
  const frontendCss = readRepoFile("src/patches/frontend/src/app.css");
  const debugMonitorCss = readRepoFile("llm-debug-monitor/src/index.css");
  const debugMonitorTailwind = readRepoFile("llm-debug-monitor/tailwind.config.js");

  assert.match(styles, /font-family:\s*'Portico Sans';/);
  assert.match(styles, /assets\/portico-sans\/PorticoSansVF\.woff2/);
  assert.doesNotMatch(styles, /Urbanist/);

  assert.match(loadingHtml, /font-family:\s*'Portico Sans';/);
  assert.match(loadingHtml, /assets\/portico-sans\/PorticoSansVF\.woff2/);
  assert.doesNotMatch(loadingHtml, /Urbanist/);

  assert.match(guidedSetupCss, /font-family:\s*'Portico Sans';/);
  assert.match(guidedSetupCss, /assets\/portico-sans\/PorticoSansVF\.woff2/);
  assert.doesNotMatch(guidedSetupCss, /Urbanist/);

  assert.match(frontendCss, /font-family:\s*'Portico Sans';/);
  assert.match(frontendCss, /static\/fonts\/portico-sans\/PorticoSansVF\.woff2/);
  assert.doesNotMatch(frontendCss, /Urbanist/);

  assert.match(debugMonitorCss, /font-family:\s*'Portico Sans';/);
  assert.match(debugMonitorCss, /assets\/fonts\/portico-sans\/PorticoSansVF\.woff2/);
  assert.doesNotMatch(debugMonitorCss, /Urbanist/);

  assert.match(debugMonitorTailwind, /sans:\s*\['Portico Sans', 'system-ui', 'sans-serif']/);
  assert.doesNotMatch(debugMonitorTailwind, /Urbanist/);
});

test("Portico Sans asset bundles exist and old Urbanist bundles are gone", () => {
  const expectedFontAssets = [
    "electron-app/assets/portico-sans/PorticoSansVF.woff2",
    "electron-app/assets/portico-sans/PorticoSansVF_It.woff2",
    "electron-app/assets/portico-sans/PorticoSans_Rg.woff2",
    "electron-app/assets/portico-sans/PorticoSans_Md.woff2",
    "electron-app/assets/portico-sans/PorticoSans_Bd.woff2",
    "electron-app/assets/portico-sans/PorticoSans_It.woff2",
    "src/patches/frontend/static/fonts/portico-sans/PorticoSansVF_It.woff2",
    "src/patches/frontend/static/fonts/portico-sans/PorticoSans_Rg.woff2",
    "src/patches/frontend/static/fonts/portico-sans/PorticoSans_Md.woff2",
    "src/patches/frontend/static/fonts/portico-sans/PorticoSans_Bd.woff2",
    "src/patches/frontend/static/fonts/portico-sans/PorticoSans_It.woff2",
    "src/patches/frontend/static/fonts/portico-sans/PorticoSansVF.woff2",
    "llm-debug-monitor/src/assets/fonts/portico-sans/PorticoSansVF_It.woff2",
    "llm-debug-monitor/src/assets/fonts/portico-sans/PorticoSans_Rg.woff2",
    "llm-debug-monitor/src/assets/fonts/portico-sans/PorticoSans_Md.woff2",
    "llm-debug-monitor/src/assets/fonts/portico-sans/PorticoSans_Bd.woff2",
    "llm-debug-monitor/src/assets/fonts/portico-sans/PorticoSans_It.woff2",
    "llm-debug-monitor/src/assets/fonts/portico-sans/PorticoSansVF.woff2",
  ];

  for (const relativePath of expectedFontAssets) {
    const bytes = readRepoBytes(relativePath);
    assert.equal(
      bytes.length > 0,
      true,
      `${relativePath} should exist`,
    );
    assert.equal(
      bytes.slice(0, 4).toString("ascii"),
      "wOF2",
      `${relativePath} should be a raw WOFF2 asset`,
    );
    assert.notEqual(
      bytes.slice(0, 4).toString("hex"),
      "1f8b0808",
      `${relativePath} should not be gzip-wrapped`,
    );
  }

  const removedUrbanistPaths = [
    "electron-app/assets/Urbanist",
    "src/patches/frontend/static/fonts/urbanist",
    "llm-debug-monitor/src/assets/fonts/Urbanist-VariableFont_wght.ttf",
  ];

  for (const relativePath of removedUrbanistPaths) {
    assert.equal(
      fs.existsSync(path.join(REPO_ROOT, relativePath)),
      false,
      `${relativePath} should be removed`,
    );
  }
});

test("Portico Sans font stack is used in browser callback pages", () => {
  const setupAuthSource = readRepoFile("electron-app/src/services/setup-auth.js");
  const gitlabAuthSource = readRepoFile("electron-app/src/services/gitlab-marketplace-auth.js");

  assert.match(setupAuthSource, /font-family:\s*"Portico Sans"/);
  assert.doesNotMatch(setupAuthSource, /Urbanist/);

  assert.match(gitlabAuthSource, /font-family:\s*"Portico Sans"/);
  assert.doesNotMatch(gitlabAuthSource, /Urbanist/);
});
