const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('main window and OWUI view share one native sidebar capability flag', () => {
  const windowsSource = read('electron-app/src/services/windows.js');
  const owuiViewsSource = read('electron-app/src/services/owui-views.js');

  assert.match(
    windowsSource,
    /const nativeSidebarVibrancy = isMacSidebarVibrancyEnabled\(\{[\s\S]*?reduceTransparency,[\s\S]*?\}\);/,
  );
  assert.match(
    windowsSource,
    /additionalArguments:\s*\[NATIVE_SIDEBAR_VIBRANCY_ARGUMENT\]/,
  );
  assert.match(
    owuiViewsSource,
    /options\.windowType === "main"\s*&&[\s\S]*?isMacSidebarVibrancyEnabled/,
  );
  assert.match(
    owuiViewsSource,
    /transparent:\s*useNativeSidebarVibrancy/,
  );
  assert.match(
    owuiViewsSource,
    /useNativeSidebarVibrancy \? "#00000000" : "#171717"/,
  );
});

test('native capability crosses both preload boundaries and clears only the shell host', () => {
  const preloadSource = read('electron-app/src/services/preload.js');
  const owuiPreloadSource = read(
    'electron-app/src/services/chat-webview-preload.js',
  );
  const indexSource = read('electron-app/src/renderer/views/index.js');
  const stylesSource = read('electron-app/src/styles.css');

  assert.match(
    preloadSource,
    /nativeSidebarVibrancy:\s*process\.argv\.includes\('--portico-native-sidebar-vibrancy'\)/,
  );
  assert.match(
    owuiPreloadSource,
    /classList\.add\('portico-native-sidebar-vibrancy'\)/,
  );
  assert.match(
    indexSource,
    /electronAPI\?\.nativeSidebarVibrancy[\s\S]*?classList\.add\('native-sidebar-vibrancy'\)/,
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\.native-sidebar-vibrancy body\s*\{[^}]*background:\s*transparent;/s,
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\.native-sidebar-vibrancy\[data-theme="dark"\] body\s*\{[^}]*background:\s*#0d0d0d;/s,
  );
  assert.match(
    stylesSource,
    /\[data-theme="dark"\] \.header\s*\{[^}]*background:\s*#0d0d0d;/s,
  );
  assert.match(
    stylesSource,
    /\[data-theme="dark"\] \.app-container,[\s\S]*?\[data-theme="dark"\] #control-tab\s*\{[^}]*background:\s*#0d0d0d;/s,
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\.native-sidebar-vibrancy \.chat-webview\s*\{[^}]*background:\s*transparent;/s,
  );
  assert.match(
    stylesSource,
    /\.conversation-session-loading-overlay\s*\{[^}]*background:\s*var\(--window-bg\);/s,
  );
});

test('app theme is synchronized to the native material appearance', () => {
  const ipcSource = read('electron-app/src/services/ipc.js');

  assert.match(
    ipcSource,
    /ipcMain\.handle\("set-theme"[\s\S]*?nativeTheme\.themeSource = theme;/s,
  );
});

test('native material stays on the main window without a focus-sensitive companion', () => {
  const windowsSource = read('electron-app/src/services/windows.js');
  const visualSource = read('electron-app/src/services/native-window-visuals.js');

  assert.match(
    visualSource,
    /getMacWindowVisualOptions[\s\S]*?vibrancy:\s*'under-window'[\s\S]*?visualEffectState:\s*'active'/,
  );
  assert.doesNotMatch(
    windowsSource,
    /mainSidebarMaterialWindow|createMainSidebarMaterialWindow|moveAbove\(/,
  );
  assert.match(
    windowsSource,
    /\.\.\.getMacWindowVisualOptions\(\{ nativeTheme, reduceTransparency \}\)/,
  );
});
