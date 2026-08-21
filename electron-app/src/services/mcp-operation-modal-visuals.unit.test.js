const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function cssRule(source, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escapedSelector}\\s*\\{`, "m").exec(source);
  const start = match?.index ?? -1;
  assert.notEqual(start, -1, `missing CSS rule for ${selector}`);
  const end = source.indexOf("}", start);
  assert.notEqual(end, -1, `unterminated CSS rule for ${selector}`);
  return source.slice(start, end + 1);
}

test("MCP operation modal keeps its complete accessible progress contract", () => {
  const html = read("electron-app/src/renderer/views/index.html");
  const modalStart = html.indexOf('id="mcp-operation-overlay"');
  const modalEnd = html.indexOf('id="debug-request-modal"', modalStart);
  const modal = html.slice(modalStart, modalEnd);

  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /aria-labelledby="mcp-operation-title"/);
  assert.match(
    modal,
    /class="loading-progress-header-icon"[\s\S]*?<svg[\s\S]*?id="mcp-operation-spinner"/,
  );
  assert.match(modal, /id="mcp-operation-title"/);
  assert.match(modal, /id="mcp-operation-subtitle"/);
  assert.match(modal, /id="mcp-operation-summary"/);
  assert.match(modal, /id="mcp-operation-bar-fill"/);
  assert.match(modal, /id="mcp-operation-list"/);
  assert.match(modal, /id="mcp-operation-footer-message"/);
  assert.match(modal, /id="mcp-operation-done-btn"/);
  assert.match(
    modal,
    /id="mcp-operation-background-btn"[\s\S]*?title="Continue in background"[\s\S]*?aria-label="Continue operation in background"[\s\S]*?<svg/,
  );
});

test("MCP operation modal shows an eye hide button left of the close button", () => {
  const html = read("electron-app/src/renderer/views/index.html");
  const controlPlane = read("electron-app/src/renderer/components/control-plane.js");
  const modalStart = html.indexOf('id="mcp-operation-overlay"');
  const modalEnd = html.indexOf('id="debug-request-modal"', modalStart);
  const modal = html.slice(modalStart, modalEnd);

  const hideIndex = modal.indexOf('id="mcp-operation-hide-btn"');
  const closeIndex = modal.indexOf('id="mcp-operation-background-btn"');
  assert.notEqual(hideIndex, -1);
  assert.ok(hideIndex < closeIndex, "eye button must precede the X button");
  // The eye glyph communicates that the operation can be hidden without cancellation.
  assert.match(
    modal.slice(hideIndex, closeIndex),
    /M2 12s3\.5-7 10-7 10 7 10 7-3\.5 7-10 7S2 12 2 12Z/,
  );
  assert.match(controlPlane, /hideButton: document\.getElementById\('mcp-operation-hide-btn'\)/);
  assert.match(controlPlane, /hideButton\?\.addEventListener\('click', background\)/);
});

test("title-bar operation pill lays the count out beside the title", () => {
  const html = read("electron-app/src/renderer/views/index.html");

  assert.match(
    html,
    /\.mcp-operation-banner \{[^}]*max-width: 30rem;/s,
  );
  assert.match(
    html,
    /\.mcp-operation-banner-copy \{[^}]*display: inline-flex;[^}]*align-items: baseline;/s,
  );
  assert.doesNotMatch(html, /\.mcp-operation-banner-copy \{[^}]*display: grid;/s);
});

test("MCP operation modal uses one scoped flat surface with a divided list", () => {
  const styles = read("electron-app/src/styles.css");
  const overlayRule = cssRule(styles, ".mcp-operation-overlay");
  const shellRule = cssRule(styles, ".loading-progress-shell");
  const headerRule = cssRule(styles, ".loading-progress-header");
  const listRule = cssRule(styles, ".loading-progress-list");
  const rowRule = cssRule(styles, ".loading-progress-row");

  assert.match(overlayRule, /--mcp-operation-surface:/);
  assert.match(overlayRule, /--mcp-operation-divider:/);
  assert.match(shellRule, /background:\s*var\(--mcp-operation-surface\)/);
  assert.doesNotMatch(shellRule, /backdrop-filter/);
  assert.match(
    headerRule,
    /border-bottom:\s*1px solid var\(--mcp-operation-divider\)/,
  );
  assert.doesNotMatch(headerRule, /border-radius|background:/);
  assert.match(listRule, /overflow-y:\s*auto/);
  assert.match(listRule, /background:\s*var\(--mcp-operation-list-surface\)/);
  assert.match(
    rowRule,
    /border-bottom:\s*1px solid var\(--mcp-operation-divider\)/,
  );
  assert.match(rowRule, /box-shadow:\s*none/);
  assert.match(
    styles,
    /\.loading-progress-row:last-child\s*\{[\s\S]*?border-bottom:\s*0/,
  );
});

test("MCP operation activity uses animated building blocks instead of circular spinners", () => {
  const html = read("electron-app/src/renderer/views/index.html");
  const renderer = read(
    "electron-app/src/renderer/components/control-plane.js",
  );
  const styles = read("electron-app/src/styles.css");
  const headerLoader = html.match(
    /class="spinner loading-progress-spinner"[\s\S]*?id="mcp-operation-spinner"[\s\S]*?>([\s\S]*?)<\/div>/,
  );

  assert(headerLoader);
  assert.equal((headerLoader[1].match(/<span><\/span>/g) || []).length, 4);
  assert.match(
    renderer,
    /class="\$\{iconClasses\.join\('\s'\)\}" aria-hidden="true">\s*<span><\/span><span><\/span><span><\/span><span><\/span>/,
  );
  assert.match(
    styles,
    /\.loading-progress-spinner span,[\s\S]*?\.loading-progress-row-icon\.active span[\s\S]*?animation:\s*mcp-operation-block-pulse/,
  );
  assert.match(styles, /@keyframes mcp-operation-block-pulse/);
  assert.doesNotMatch(
    cssRule(styles, ".loading-progress-row-icon.active"),
    /animation:\s*spin/,
  );
});

test("MCP operation setup-required rows use the shared warning palette", () => {
  const styles = read("electron-app/src/styles.css");
  const iconRule = cssRule(
    styles,
    ".loading-progress-row-icon.terminal-warning",
  );
  const stageRule = cssRule(
    styles,
    ".loading-progress-row.terminal-warning .loading-progress-row-stage",
  );
  const barRule = cssRule(
    styles,
    ".loading-progress-row.terminal-warning .loading-progress-row-bar-fill",
  );

  assert.match(iconRule, /background:\s*var\(--status-warning-bg\)/);
  assert.match(iconRule, /color:\s*var\(--status-warning\)/);
  assert.match(stageRule, /background:\s*var\(--status-warning-bg\)/);
  assert.match(stageRule, /color:\s*var\(--status-warning\)/);
  assert.match(barRule, /background:\s*var\(--status-warning\)/);
  assert.match(
    styles,
    /\.loading-progress-row-icon\.terminal-warning::after\s*\{[^}]*content:\s*"!";/s,
  );
  assert.match(
    styles,
    /\[data-theme="light"\] \.mcp-operation-overlay \.loading-progress-row\.terminal-warning \.loading-progress-row-stage\s*\{[^}]*var\(--status-warning-bg\)[^}]*var\(--status-warning\)/s,
  );
  assert.doesNotMatch(styles, /\.loading-progress-row-stage\.stage-needs_oauth/);
});

test("MCP operation modal has explicit light, dark, focus, motion, and narrow-screen treatment", () => {
  const styles = read("electron-app/src/styles.css");

  assert.match(styles, /\.mcp-operation-overlay\s*\{[\s\S]*?background:/);
  assert.match(
    styles,
    /\[data-theme="light"\] \.mcp-operation-overlay\s*\{[\s\S]*?--mcp-operation-surface:[\s\S]*?background:/,
  );
  assert.match(
    styles,
    /\.loading-progress-close-btn:focus-visible,[\s\S]*?\.mcp-operation-row-action:focus-visible/,
  );
  assert.match(
    styles,
    /@media \(max-width: 640px\)[\s\S]*?\.loading-progress-shell[\s\S]*?calc\(100vw - 24px\)/,
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.loading-progress-shell[\s\S]*?animation:\s*none/,
  );
});

test("MCP operation modal restores macOS window dragging without swallowing controls", () => {
  const styles = read("electron-app/src/styles.css");

  assert.match(
    styles,
    /\.platform-darwin \.mcp-operation-overlay\.visible\s*\{[\s\S]*?-webkit-app-region:\s*drag/,
  );
  assert.match(
    styles,
    /\.platform-darwin \.mcp-operation-overlay \.loading-progress-header\s*\{[\s\S]*?-webkit-app-region:\s*drag/,
  );
  assert.match(
    styles,
    /\.platform-darwin \.mcp-operation-overlay \.loading-progress-header-actions,[\s\S]*?\.loading-progress-body,[\s\S]*?\.mcp-operation-footer,[\s\S]*?\.mcp-operation-overlay button\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/,
  );
});
