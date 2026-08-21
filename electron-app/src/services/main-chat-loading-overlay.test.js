const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const mainChatScript = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'chat-tab.js',
);
const mainChatHtml = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'views',
  'index.html',
);
const stylesPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'styles.css',
);

test('main chat tab shows the session-loading veil from first paint', () => {
  const htmlSource = fs.readFileSync(mainChatHtml, 'utf8');

  assert.equal(
    htmlSource.includes('id="main-chat-session-loading-overlay"'),
    true,
    'main chat should render its own loading veil element',
  );
  assert.equal(
    htmlSource.includes('conversation-session-loading-overlay visible'),
    true,
    'main chat loading veil should start visible in the HTML',
  );
  assert.equal(
    htmlSource.includes('Preparing new session...'),
    true,
    'main chat should reuse the detached-window loading copy',
  );
});

test('main chat initial load suppresses the OWUI host behind the loading veil', () => {
  const scriptSource = fs.readFileSync(mainChatScript, 'utf8');
  const stylesSource = fs.readFileSync(stylesPath, 'utf8');

  assert.equal(
    scriptSource.includes("INITIAL_SESSION_LOADING_MIN_MS = 2200"),
    true,
    'main chat should keep the initial loading veil up for a couple seconds',
  );
  assert.equal(
    scriptSource.includes("INITIAL_SESSION_LOADING_MAX_MS = 4200"),
    true,
    'main chat should force-release the initial loading veil after the same handoff window',
  );
  assert.equal(
    scriptSource.includes(
      "window.setOwuiInteractionSuppressed?.(INITIAL_SESSION_SUPPRESSION_REASON, true);",
    ),
    true,
    'main chat should suppress the OWUI host while the initial loading veil is visible',
  );
  assert.equal(
    scriptSource.includes('showInitialSessionLoadingOverlay();'),
    true,
    'main chat should enable the loading veil before beginning the OWUI load',
  );
  assert.match(
    stylesSource,
    /#chat-tab\.active\s*\{[^}]*position:\s*relative;/s,
    'main chat should establish a positioned parent for the full-tab loading veil',
  );
  for (const selector of [
    '\\.chat-webview',
    '\\.conversation-session-loading-overlay',
    '\\.chat-placeholder',
  ]) {
    assert.match(
      stylesSource,
      new RegExp(`${selector}\\s*\\{[^}]*background:\\s*var\\(--window-bg\\);`, 's'),
      `${selector} should use the shared window canvas without an old grey first-paint flash`,
    );
  }
});

test('main chat startup overlay exposes debug log collection', () => {
  const scriptSource = fs.readFileSync(mainChatScript, 'utf8');

  assert.match(
    scriptSource,
    /async function collectDebugInfoFromReconnectOverlay\(button\)/,
    'chat reconnect overlay should own a debug collection handler',
  );
  assert.match(
    scriptSource,
    /id="reconnect-debug-btn"/,
    'chat reconnect overlay should render a debug collection button',
  );
  assert.match(
    scriptSource,
    /window\.electronAPI\.collectDebugInfo\(\)/,
    'chat reconnect overlay should call the debug collection IPC directly',
  );
  assert.match(
    scriptSource,
    /reconnect-debug-status/,
    'chat reconnect overlay should show debug collection status',
  );
});
