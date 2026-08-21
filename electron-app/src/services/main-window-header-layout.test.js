const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const stylesPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'styles.css',
);
const windowsServicePath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'windows.js',
);
const preloadPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'preload.js',
);
const ipcPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'ipc.js',
);
const indexViewPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'views',
  'index.js',
);
const tabBarPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'tab-bar.js',
);

test('mac main window header keeps a tighter top chrome footprint', () => {
  const stylesSource = fs.readFileSync(stylesPath, 'utf8');
  const windowsSource = fs.readFileSync(windowsServicePath, 'utf8');
  const preloadSource = fs.readFileSync(preloadPath, 'utf8');
  const ipcSource = fs.readFileSync(ipcPath, 'utf8');
  const indexSource = fs.readFileSync(indexViewPath, 'utf8');
  const tabBarSource = fs.readFileSync(tabBarPath, 'utf8');
  const createMainWindowBlock = windowsSource.slice(
    windowsSource.indexOf('function createMainWindow() {'),
    windowsSource.indexOf('const TOOLTIP_WINDOW_CONFIG = Object.freeze({'),
  );
  const setMacTrafficLightPositionBlock = windowsSource.slice(
    windowsSource.indexOf('function setMacTrafficLightPosition(position) {'),
    windowsSource.indexOf('/**\n * Dependency injection container for cross-module functions'),
  );

  assert.match(
    stylesSource,
    /\.platform-darwin\s*\{[^}]*--window-drag-strip-height:\s*0px;[^}]*\}/s,
    'macOS main shell should eliminate the separate drag strip height',
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\s+\.window-drag-strip\s*\{[^}]*display:\s*none;[^}]*height:\s*0;[^}]*\}/s,
    'macOS main shell should hide the dedicated drag strip row',
  );
  assert.match(
    stylesSource,
    /--mac-main-header-content-height:\s*38px;[\s\S]*--mac-main-header-padding-y:\s*0\.19rem;[\s\S]*--mac-main-header-height:\s*calc\(var\(--mac-main-header-content-height\) \+ var\(--mac-main-header-padding-y\) \+ var\(--mac-main-header-padding-y\)\);/s,
    'macOS main header dimensions should be named tokens shared by detached conversation windows',
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\s+\.header\s*\{[^}]*--header-control-height:\s*28px;[^}]*padding:\s*var\(--mac-main-header-padding-y\) 0\.77rem;[^}]*-webkit-app-region:\s*drag;[^}]*\}/s,
    'macOS main shell should use a compact shared widget height by default while keeping the header itself as the titlebar drag plane',
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\s+\.header-content\s*\{[^}]*grid-template-columns:[^}]*minmax\(0,\s*1fr\)[^}]*min-height:\s*var\(--mac-main-header-content-height\);[^}]*padding-left:\s*var\(--mac-native-controls-safe-left\);[^}]*padding-right:\s*0\.24rem;[^}]*-webkit-app-region:\s*drag;[^}]*position:\s*relative;[^}]*\}/s,
    'header content should reserve the macOS traffic-light safe area and give the tab strip a real shrinkable middle grid track',
  );
  assert.match(
    stylesSource,
    /body\.tab-rename-active \.header,\s*body\.tab-rename-active \.header \*,\s*body\.tab-rename-active \.window-drag-strip\s*\{[^}]*-webkit-app-region:\s*no-drag !important;[^}]*\}/s,
    'inline tab rename should temporarily make the whole header renderer-clickable, including empty chrome space',
  );
  assert.match(
    stylesSource,
    /\.header\s*\{[^}]*--header-control-height:\s*34px;[^}]*--tab-rail-center-x:\s*50%;[^}]*--tab-rail-max-width:\s*70vw;[^}]*\}/s,
    'header controls should share one explicit control height and default centered tab rail variables',
  );
  assert.match(
    stylesSource,
    /--mac-native-controls-safe-left:\s*96px;/,
    'macOS main shell should keep a little more breathing room to the right of the traffic lights',
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\s+\.header-left\s*\{[^}]*grid-column:\s*1;[^}]*top:\s*0;[^}]*left:\s*-12px;[^}]*\}/s,
    'macOS header left content should stay pinned to the first grid column',
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\s+\.header-actions\s*\{[^}]*grid-column:\s*3;[^}]*position:\s*relative;[^}]*top:\s*0;[^}]*\}/s,
    'macOS header right actions should stay pinned to the third grid column',
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\s+\.tab-bar-container\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*justify-self:\s*start;[^}]*width:\s*max-content;[^}]*position:\s*absolute;[^}]*left:\s*var\(--tab-rail-center-x,\s*50%\);[^}]*top:\s*50%;[^}]*transform:\s*translate\(-50%,\s*-50%\);[^}]*z-index:\s*102;[^}]*max-width:\s*var\(--tab-rail-max-width,\s*100%\);[^}]*\}/s,
    'macOS tab bar container should be centered on the measured window center and clamped away from side chrome',
  );
  assert.match(
    tabBarSource,
    /const headerContentStyle = window\.getComputedStyle\?\.\(headerContent\);[\s\S]*const headerContentPaddingLeft = Number\.parseFloat\(headerContentStyle\?\.paddingLeft \|\| '0'\) \|\| 0;/s,
    'tab rail centering should account for the padded absolute-positioning origin inside header-content',
  );
  assert.match(
    tabBarSource,
    /const leftAvailable = Math\.max\([\s\S]*headerCenterX - leftChromeEdge - TAB_RAIL_CHROME_GAP_PX[\s\S]*const rightAvailable = Math\.max\([\s\S]*rightChromeEdge - headerCenterX - TAB_RAIL_CHROME_GAP_PX[\s\S]*Math\.floor\(Math\.min\(leftAvailable, rightAvailable\) \* 2\)/s,
    'tab rail max width should be clamped symmetrically around the true header center',
  );
  assert.match(
    tabBarSource,
    /'--tab-rail-center-x',[\s\S]*`\$\{Math\.round\(headerCenterX - headerContentRect\.left - headerContentPaddingLeft\)\}px`/s,
    'tab rail center should be written relative to the actual absolute-positioning origin',
  );
  assert.doesNotMatch(
    stylesSource,
    /\.platform-darwin\s+\.tab-bar-container\s*\{[^}]*justify-self:\s*stretch;[^}]*width:\s*100%;/s,
    'macOS tab rail should not stretch across the whole middle header track',
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\s+body\.mac-fullscreen\s+\.header\s*\{[^}]*--header-control-height:\s*26px;[^}]*padding:\s*0\.16rem 0\.69rem;[^}]*\}/s,
    'macOS fullscreen mode should keep the tighter header padding and shared control height for extra vertical real estate',
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\s+body\.mac-fullscreen\s+\.header-content\s*\{[^}]*min-height:\s*36px;[^}]*padding-left:\s*0\.28rem;[^}]*padding-right:\s*0\.18rem;[^}]*\}/s,
    'macOS fullscreen mode should still drop the traffic-light safe inset so the MCP badge can sit near the left edge',
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\s+body\.mac-fullscreen\s+\.header-left\s*\{[^}]*top:\s*0;[^}]*left:\s*-2px;[^}]*\}/s,
    'macOS fullscreen mode should shift the header-left badge group closer to the screen edge',
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\s+body\.mac-fullscreen\s+\.header-actions\s*\{[^}]*top:\s*0;[^}]*\}/s,
    'macOS fullscreen mode should vertically tighten the header action group',
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\s+body\.mac-fullscreen\s+\.tab-bar-container\s*\{[^}]*align-self:\s*center;[^}]*\}/s,
    'macOS fullscreen mode should keep the grid-hosted tab bar vertically centered',
  );
  assert.match(
    stylesSource,
    /\.mcp-badge\s*\{[^}]*min-height:\s*var\(--header-control-height\);[^}]*padding:\s*0 0\.75rem;[^}]*font-size:\s*0\.75rem;[^}]*line-height:\s*1;[^}]*\}/s,
    'the MCP badge should use the shared header control height so its midpoint sits on the same centerline as the other controls',
  );
  assert.doesNotMatch(
    stylesSource,
    /\.mcp-badge\s*\{[^}]*font:\s*inherit;[^}]*\}/s,
    'the MCP badge should keep its explicit typography instead of inheriting a larger header font',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\s*\{[^}]*min-height:\s*var\(--header-control-height\);[^}]*padding:\s*0 0\.75rem;[^}]*line-height:\s*1;[^}]*\}/s,
    'tab buttons should use the shared header control height for consistent vertical centering',
  );
  assert.match(
    stylesSource,
    /\.tab-label\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;[^}]*max-width:\s*none;[^}]*text-overflow:\s*ellipsis;[^}]*text-align:\s*left;[^}]*\}/s,
    'tab labels should stay left-anchored and only ellipsize when the tab is truly constrained',
  );
  assert.match(
    stylesSource,
    /\.tab-close-btn\s*\{[^}]*flex:\s*0 0 18px;[^}]*min-width:\s*18px;[^}]*width:\s*18px;[^}]*height:\s*18px;[^}]*\}/s,
    'real tab close buttons should keep a fixed accessible size whether trailing or replacing the icon',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.conversation-tab\.compact-close-mode \.tab-icon\s*\{\s*display:\s*flex;\s*\}/s,
    'compact conversation tabs should keep the chat icon visible until hover or focus swaps it for close',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.compact-tab-mode\s*\{[^}]*flex:\s*0 0 34px;[^}]*width:\s*34px;[^}]*min-width:\s*34px;[^}]*padding:\s*0;[^}]*justify-content:\s*center;[^}]*gap:\s*0;[^}]*\}/s,
    'forced compact tabs should use fixed 34px icon slots so five visible tabs can fit at the minimum window width',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.compact-tab-mode \.tab-label,\s*\.tab-btn\.compact-tab-mode \.tab-close-spacer\s*\{\s*display:\s*none;/s,
    'the permanent Chat tab should collapse to its icon by hiding its label and spacer in forced compact mode',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.conversation-tab \.tab-status-indicator:not\(\.hidden\),\s*\.tab-btn\.compact-tab-mode \.tab-status-indicator:not\(\.hidden\)\s*\{[^}]*position:\s*absolute;[^}]*top:\s*5px;[^}]*right:\s*2px;[^}]*display:\s*block;[^}]*\}/s,
    'conversation and compact tabs should keep unread and attention indicators visible as an overlaid corner badge',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.conversation-tab\.compact-close-mode:hover \.tab-close-btn,\s*\.tab-btn\.conversation-tab\.compact-close-mode:focus-visible \.tab-close-btn,\s*\.tab-btn\.conversation-tab\.compact-close-mode:focus-within \.tab-close-btn\s*\{\s*display:\s*inline-flex;\s*\}/s,
    'compact conversation tabs should expose the real close button on hover or keyboard focus',
  );
  assert.match(
    stylesSource,
    /\.tab-close-spacer\s*\{[^}]*flex:\s*0 1 18px;[^}]*min-width:\s*0;[^}]*width:\s*18px;[^}]*height:\s*18px;[^}]*\}/s,
    'the permanent-tab spacer may collapse because it is not an interactive close target',
  );
  assert.match(
    stylesSource,
    /\.theme-toggle\s*\{[^}]*width:\s*var\(--header-control-height\);[^}]*height:\s*var\(--header-control-height\);[^}]*\}/s,
    'header icon buttons should also use the shared control height',
  );
  assert.doesNotMatch(
    stylesSource,
    /\.theme-toggle\s*\{[^}]*margin-right\s*:/s,
    'the theme toggle should not override the flex gap between header icon buttons',
  );
  assert.match(
    stylesSource,
    /\.control-plane-toggle\s*\{[^}]*width:\s*var\(--header-control-height\);[^}]*height:\s*var\(--header-control-height\);[^}]*border-radius:\s*0\.375rem;[^}]*-webkit-app-region:\s*no-drag;[^}]*\}/s,
    'the Control Plane icon button should match the shared square header button geometry',
  );
  assert.match(
    stylesSource,
    /\[data-theme="light"\]\s*\{[\s\S]*--portico-accent-text:\s*#003a9b;[\s\S]*--header-active-tab-bg:\s*var\(--portico-accent-fill\);[\s\S]*--header-active-tab-text:\s*var\(--portico-accent-text\);/s,
    'light theme should derive the selected header tab colors from the chat tool-call blue accent token',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.active\s*\{[^}]*color:\s*var\(--header-active-tab-text\);[^}]*background:\s*var\(--header-active-tab-bg\);[^}]*font-weight:\s*600;[^}]*\}/s,
    'selected header tabs should derive their colors from the shared active-tab tokens',
  );
  assert.match(
    stylesSource,
    /\[data-theme="light"\]\s+\.tab-btn\.active\s+\.tab-detach-btn\s*\{[^}]*color:\s*var\(--header-active-tab-text\);[^}]*\}/s,
    'light mode selected chat tabs should render the detach icon in the same white as the active tab label',
  );
  assert.match(
    windowsSource,
    /const DEFAULT_MAC_TRAFFIC_LIGHT_POSITION = Object\.freeze\(\{ x: 21, y: 24 \}\);[\s\S]*let currentMacTrafficLightPosition = \{ \.\.\.DEFAULT_MAC_TRAFFIC_LIGHT_POSITION \};/s,
    'guided setup should keep its taller macOS traffic light baseline',
  );
  assert.match(
    windowsSource,
    /const DEFAULT_MAIN_MAC_TRAFFIC_LIGHT_POSITION = Object\.freeze\(\{ x: 21, y: 15 \}\);[\s\S]*let currentMainMacTrafficLightPosition = \{ \.\.\.DEFAULT_MAIN_MAC_TRAFFIC_LIGHT_POSITION \};/s,
    'the main shell should keep its own macOS traffic light baseline for the moderately slim header',
  );
  assert.match(
    windowsSource,
    /function getDetachedConversationMacTrafficLightPosition\(\s*position = DEFAULT_MAIN_MAC_TRAFFIC_LIGHT_POSITION,\s*\) \{[\s\S]*return \{ \.\.\.DEFAULT_MAIN_MAC_TRAFFIC_LIGHT_POSITION \};[\s\S]*return normalized;/s,
    'detached conversation windows should use the main-window macOS traffic light baseline',
  );
  assert.match(
    setMacTrafficLightPositionBlock,
    /function setMacTrafficLightPosition\(position\) \{[\s\S]*currentMainMacTrafficLightPosition = normalized;[\s\S]*if \(state\.windows\.main && !state\.windows\.main\.isDestroyed\(\)\) \{[\s\S]*applyMacTrafficLightPosition\(state\.windows\.main,\s*currentMainMacTrafficLightPosition\);[\s\S]*appliedCount = 1;[\s\S]*position:\s*\{ \.\.\.currentMainMacTrafficLightPosition \}/s,
    'macOS traffic light tuning should only retune the main shell at runtime',
  );
  assert.doesNotMatch(
    setMacTrafficLightPositionBlock,
    /BrowserWindow\.getAllWindows\(\)/,
    'runtime traffic light tuning should not fan out across guided setup or detached windows',
  );
  assert.match(
    preloadSource,
    /setMacTrafficLightPosition:\s*\(x,\s*y\)\s*=>\s*ipcRenderer\.invoke\('set-mac-traffic-light-position',\s*\{\s*x,\s*y\s*\}\)/,
    'the renderer should expose a live traffic light tuning bridge through preload',
  );
  assert.match(
    preloadSource,
    /isCurrentWindowFullscreen:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('window-is-full-screen'\)/,
    'the renderer should expose a fullscreen-state getter for the current BrowserWindow',
  );
  assert.match(
    preloadSource,
    /onWindowFullscreenChanged:\s*\(callback\)\s*=>\s*\{[\s\S]*ipcRenderer\.on\('window-fullscreen-changed',\s*\(_event,\s*isFullscreen\)\s*=>[\s\S]*callback\(Boolean\(isFullscreen\)\)/s,
    'the renderer should expose a native fullscreen change listener',
  );
  assert.match(
    ipcSource,
    /ipcMain\.handle\("window-is-full-screen",\s*\(event\)\s*=>\s*\{[\s\S]*BrowserWindow\.fromWebContents\(event\.sender\)[\s\S]*window\.isFullScreen\(\)/s,
    'the main process should answer fullscreen-state requests using the sender BrowserWindow',
  );
  assert.match(
    stylesSource,
    /:root\s*\{[\s\S]*--header-border:\s*rgba\(255,\s*255,\s*255,\s*0\.045\);/s,
    'dark theme header divider should use the shared subtle border token',
  );
  assert.match(
    stylesSource,
    /\[data-theme="light"\]\s*\{[\s\S]*--header-border:\s*rgba\(15,\s*23,\s*42,\s*0\.07\);/s,
    'light theme should use the shared quiet header divider while preserving the shell boundary',
  );
  assert.match(
    createMainWindowBlock,
    /titleBarStyle:\s*'hidden'[\s\S]*trafficLightPosition:\s*currentMainMacTrafficLightPosition/,
    'the main window should use the simpler hidden-titlebar traffic light path',
  );
  assert.match(
    createMainWindowBlock,
    /minWidth:\s*640,/,
    'the main window should allow compact resizing down to the requested half-width floor',
  );
  assert.doesNotMatch(
    createMainWindowBlock,
    /minWidth:\s*1200,/,
    'the main window should not keep the old wide minimum width',
  );
  assert.doesNotMatch(
    createMainWindowBlock,
    /titleBarOverlay:\s*true/,
    'the main window should not enable titleBarOverlay on macOS',
  );
  assert.match(
    createMainWindowBlock,
    /state\.windows\.main\.once\('ready-to-show'[\s\S]*applyMacTrafficLightPosition\(state\.windows\.main,\s*currentMainMacTrafficLightPosition\)/,
    'the main window should reapply the macOS traffic light position at runtime after showing and maximizing',
  );
  assert.match(
    createMainWindowBlock,
    /const syncMainWindowFullscreenState = \(\) => \{[\s\S]*sendToMainWindow\(\s*'window-fullscreen-changed',[\s\S]*Boolean\(state\.windows\.main\?\.isFullScreen\?\.?\(\)\)/s,
    'the main window should derive fullscreen state from the native BrowserWindow and send it to the renderer',
  );
  assert.match(
    createMainWindowBlock,
    /state\.windows\.main\.webContents\.on\('did-finish-load'[\s\S]*syncMainWindowFullscreenState\(\);/s,
    'the main window should sync initial fullscreen state after the renderer finishes loading',
  );
  assert.match(
    createMainWindowBlock,
    /state\.windows\.main\.on\('enter-full-screen',\s*syncMainWindowFullscreenState\);[\s\S]*state\.windows\.main\.on\('leave-full-screen',\s*syncMainWindowFullscreenState\);/s,
    'the main window should listen to Electron enter-full-screen and leave-full-screen events',
  );
  assert.match(
    indexSource,
    /document\.body\?\.classList\.toggle\('mac-fullscreen',\s*Boolean\(isFullscreen\)\);/,
    'the renderer should apply a fullscreen-only body class for header layout adjustments',
  );
  assert.match(
    indexSource,
    /window\.electronAPI\.onWindowFullscreenChanged\(\(isFullscreen\)\s*=>\s*\{[\s\S]*applyMacFullscreenState\(isFullscreen\);/s,
    'the renderer should subscribe to native fullscreen change events',
  );
  assert.match(
    indexSource,
    /const isFullscreen = await window\.electronAPI\.isCurrentWindowFullscreen\(\);[\s\S]*applyMacFullscreenState\(isFullscreen\);/s,
    'the renderer should fetch the initial fullscreen state before laying out the header',
  );
});
