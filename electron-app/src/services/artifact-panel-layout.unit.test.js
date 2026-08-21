const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const artifactPanelPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'artifact-panel.js',
);
const artifactIndicatorPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'artifact-indicator.js',
);
const preloadPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'preload.js',
);
const artifactViewsPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'artifact-views.js',
);
const apiPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'api.js',
);
const artifactViewHostPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'artifact-view-host.js',
);
const artifactDividerOverlayPreloadPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'artifact-divider-overlay-preload.js',
);
const ipcPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'ipc.js',
);
const windowsPath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'windows.js',
);
const indexHtmlPath = path.join(
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

test('artifact panel uses a native child window for the version menu instead of clipping the live preview', () => {
  const artifactPanelSource = fs.readFileSync(artifactPanelPath, 'utf8');
  const indexHtmlSource = fs.readFileSync(indexHtmlPath, 'utf8');

  assert.match(
    artifactPanelSource,
    /async presentVersionDropdown\(\)\s*\{[\s\S]*artifactVersionMenu\.show\(payload\)[\s\S]*\}/s,
    'artifact panel should request the version menu through the native artifactVersionMenu bridge',
  );
  assert.match(
    artifactPanelSource,
    /handleVersionMenuEvent\(payload = \{\}\)\s*\{[\s\S]*payload\.type === 'select'[\s\S]*payload\.type === 'close'[\s\S]*\}/s,
    'artifact panel should react to native version menu select and close events',
  );
  assert.doesNotMatch(
    artifactPanelSource,
    /artifact-dropdown-preview-inset|getOpenDropdownPreviewInset|applyDropdownPreviewInset/,
    'artifact panel should no longer shift the preview host to make room for a DOM dropdown',
  );
  assert.doesNotMatch(
    indexHtmlSource,
    /id="version-dropdown-menu"/,
    'the attached artifact header should no longer keep a DOM dropdown menu surface in the main renderer',
  );
});

test('artifact divider drag is driven by the native overlay bridge instead of renderer pointer tracking', () => {
  const artifactPanelSource = fs.readFileSync(artifactPanelPath, 'utf8');
  const artifactDividerOverlayPreloadSource = fs.readFileSync(artifactDividerOverlayPreloadPath, 'utf8');
  const ipcSource = fs.readFileSync(ipcPath, 'utf8');
  const windowsSource = fs.readFileSync(windowsPath, 'utf8');

  assert.match(
    artifactPanelSource,
    /window\.electronAPI\?\.artifactDividerOverlay\?\.onEvent\?\.\(\(payload\) => \{\s*this\.handleDividerOverlayEvent\(payload\);/s,
    'artifact panel should subscribe to divider drag events from the native overlay bridge',
  );
  assert.match(
    artifactPanelSource,
    /syncDividerOverlay\(\)\s*\{[\s\S]*artifactDividerOverlay\.sync\(\{[\s\S]*x:\s*Math\.round\(rect\.left\)[\s\S]*\}\)/s,
    'artifact panel should continuously align the native divider overlay to the visible divider rect',
  );
  assert.match(
    artifactPanelSource,
    /closeDropdown\(options = \{\}\)\s*\{[\s\S]*setDropdownOpenState\(false\);[\s\S]*queueDividerOverlaySync\(\);[\s\S]*if \(options\.hideNative === false\)\s*\{\s*return;/s,
    'closing the version menu should always schedule the divider overlay to re-sync before any early return',
  );
  assert.match(
    artifactDividerOverlayPreloadSource,
    /artifact-divider-overlay-hover-start[\s\S]*artifact-divider-overlay-hover-end[\s\S]*window\.addEventListener\('mouseenter'[\s\S]*window\.addEventListener\('mouseleave'/s,
    'divider overlay preload should forward hover enter and leave events to the owner renderer',
  );
  assert.match(
    ipcSource,
    /ipcMain\.on\('artifact-divider-overlay-hover-start'[\s\S]*forwardArtifactDividerOverlayHover\(\{ type: 'hover-start' \}\);[\s\S]*ipcMain\.on\('artifact-divider-overlay-hover-end'[\s\S]*forwardArtifactDividerOverlayHover\(\{ type: 'hover-end' \}\);/s,
    'main IPC should validate overlay hover events before forwarding them to the owner window',
  );
  assert.match(
    windowsSource,
    /function forwardArtifactDividerOverlayHover\(payload = \{\}\)\s*\{[\s\S]*sendArtifactDividerOverlayOwnerEvent\(\{ type \}\);[\s\S]*\}/s,
    'windows service should reuse the existing divider owner event channel for hover events',
  );
  assert.match(
    artifactPanelSource,
    /payload\.type === 'hover-start'[\s\S]*setArtifactDividerHoverState\(true\)[\s\S]*payload\.type === 'hover-end'[\s\S]*clearArtifactDividerHoverState\(\);/s,
    'artifact panel should toggle a renderer hover class from native overlay hover events',
  );
  assert.doesNotMatch(
    artifactPanelSource,
    /pointerdown|pointermove|pointerup|pointercancel|setPointerCapture|releasePointerCapture|pointerId/,
    'artifact divider drag should not depend on renderer pointer capture anymore',
  );
});

test('artifact panel layout uses per-tab native view keys and a 640px chat minimum', () => {
  const artifactPanelSource = fs.readFileSync(artifactPanelPath, 'utf8');
  const stylesSource = fs.readFileSync(stylesPath, 'utf8');
  const preloadSource = fs.readFileSync(preloadPath, 'utf8');
  const ipcSource = fs.readFileSync(ipcPath, 'utf8');

  assert.match(
    artifactPanelSource,
    /const ARTIFACT_CHAT_MIN_WIDTH = 640;/,
    'artifact divider should clamp the chat pane to the normal no-artifact app minimum width',
  );
  assert.match(
    artifactPanelSource,
    /const ARTIFACT_DIVIDER_FALLBACK_WIDTH = 6;/,
    'artifact divider drag math should fall back to the same 6px width as the visible divider',
  );
  assert.match(
    artifactPanelSource,
    /function getArtifactViewKeyForTab\(tabKey\)[\s\S]*return `attached-artifact-panel:\$\{safeTabKey\}`;/s,
    'attached artifact native views should be keyed per tab',
  );
  assert.doesNotMatch(
    artifactPanelSource,
    /viewKey:\s*'attached-artifact-panel'/,
    'attached artifact native views should not reuse a single global view key',
  );
  assert.match(
    artifactPanelSource,
    /async setArtifactLayoutActive\(active\)[\s\S]*ARTIFACT_CHAT_MIN_WIDTH \* 2[\s\S]*getArtifactDividerWidth\(\)/s,
    'artifact panel should request a dynamic window minimum wide enough for equal chat and artifact panes',
  );
  assert.match(
    stylesSource,
    /\.chat-container\.with-artifact-panel\s*\{[^}]*min-width:\s*640px;[^}]*\}/s,
    'artifact layout CSS should keep the chat side at the normal app minimum width',
  );
  assert.match(
    preloadSource,
    /setArtifactLayoutActive:\s*\(payload = \{\}\)\s*=>\s*ipcRenderer\.invoke\('window-set-artifact-layout-active',\s*payload\)/,
    'preload should expose the narrow window minimum bridge for artifact layout',
  );
  assert.match(
    ipcSource,
    /ipcMain\.handle\("window-set-artifact-layout-active"[\s\S]*setMinimumSize\(nextMinWidth,\s*nextMinHeight\)[\s\S]*setBounds\(\{[\s\S]*width:\s*nextMinWidth/s,
    'main IPC should raise and enforce the main window minimum width while an attached artifact is visible',
  );
});

test('artifact routing keeps the first attached artifact per tab and detaches different artifacts for occupied tabs', () => {
  const artifactPanelSource = fs.readFileSync(artifactPanelPath, 'utf8');
  const ipcSource = fs.readFileSync(path.join(repoRoot, 'electron-app', 'src', 'services', 'ipc.js'), 'utf8');
  const artifactWindowPreloadSource = fs.readFileSync(
    path.join(repoRoot, 'electron-app', 'src', 'services', 'artifact-window-preload.js'),
    'utf8',
  );

  assert.match(
    artifactPanelSource,
    /this\.attachedArtifactsByTab = new Map\(\);/,
    'artifact panel should track attached artifacts by tab',
  );
  assert.match(
    artifactPanelSource,
    /routeArtifactOpen\(data, options = \{\}\)[\s\S]*resolveTabKeyForChatId\(requestedChatId\)[\s\S]*targetState\.artifact\.artifact_id !== data\.artifact_id[\s\S]*this\.openDetached\(data\)/s,
    'artifact-open routing should detach a different artifact when the target tab slot is already occupied',
  );
  assert.match(
    artifactPanelSource,
    /canAttachArtifactToChat\(chatId = null, artifactId = null\)[\s\S]*state\.artifact\.artifact_id === artifactId/s,
    'attach checks should be scoped to the target chat tab slot',
  );
  assert.match(
    ipcSource,
    /artifact-can-attach"[\s\S]*canAttachArtifactToChat\?\.\(\$\{JSON\.stringify\(chatId\)\}, \$\{JSON\.stringify\(artifactId\)\}\)/s,
    'main IPC should ask the renderer about the requested chat tab instead of global panel occupancy',
  );
  assert.match(
    artifactWindowPreloadSource,
    /attachToMain:\s*\(artifactId,\s*chatId = null\)[\s\S]*ipcRenderer\.invoke\('artifact-attach', \{ artifactId, chatId \}\)/s,
    'detached artifact windows should pass chatId when reattaching to the main window',
  );
});

test('artifact lifecycle reuses healthy runtimes and releases only the final view', () => {
  const artifactPanelSource = fs.readFileSync(artifactPanelPath, 'utf8');
  const ipcSource = fs.readFileSync(path.join(repoRoot, 'electron-app', 'src', 'services', 'ipc.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(repoRoot, 'electron-app', 'src', 'services', 'preload.js'), 'utf8');

  assert.match(
    artifactPanelSource,
    /retainArtifactView\(artifactId, tabKey\)[\s\S]*artifacts\.retainView\(artifactId, getArtifactViewKeyForTab\(tabKey\)\)[\s\S]*releaseArtifactView\(artifactId, tabKey\)[\s\S]*artifacts\.releaseView\([\s\S]*getArtifactViewKeyForTab\(tabKey\)/s,
    'the renderer should retain and release each attached view with a stable key',
  );
  assert.match(
    ipcSource,
    /artifact-retain-view[\s\S]*attachedArtifactViews\.set\(artifactId, leases\)/s,
    'main IPC should track attached view leases',
  );
  assert.match(
    ipcSource,
    /stopArtifactRuntimeIfUnused\(artifactId\)[\s\S]*hasDetachedArtifactView\(artifactId\)[\s\S]*hasAttachedArtifactView\(artifactId\)[\s\S]*callArtifactTool\("close_artifact"/s,
    'main IPC should close a runtime only after all attached and detached views are gone',
  );
  assert.match(
    ipcSource,
    /windowInfo\.reattaching = true;[\s\S]*windowInfo\.window\.close\(\)/s,
    'reattaching should mark the detached close as a view transfer',
  );
  assert.match(
    preloadSource,
    /retainView:\s*\(artifactId, viewKey\)[\s\S]*artifact-retain-view[\s\S]*releaseView:\s*\(artifactId, viewKey\)[\s\S]*artifact-release-view/s,
    'preload should expose attached-view leases through a narrow IPC bridge',
  );
});

test('artifact refresh reloads healthy previews and recovers dead runtimes', () => {
  const artifactPanelSource = fs.readFileSync(artifactPanelPath, 'utf8');
  const ipcSource = fs.readFileSync(path.join(repoRoot, 'electron-app', 'src', 'services', 'ipc.js'), 'utf8');

  assert.match(
    ipcSource,
    /artifact-refresh-runtime[\s\S]*callArtifactTool\("get_artifact_status"[\s\S]*previewIsReachable\(status\.preview_url\)[\s\S]*restarted:\s*false[\s\S]*force_restart:\s*true[\s\S]*callArtifactTool\("open_artifact"/s,
    'refresh should use authoritative runtime status and force recovery only when its live preview is unreachable',
  );
  assert.match(
    artifactPanelSource,
    /async refresh\(\)[\s\S]*artifacts\?\.refreshRuntime\?\.[\s\S]*safeLoadWebview\(result\.preview_url,[\s\S]*forceLoad:\s*true,[\s\S]*bypassCache:\s*true/s,
    'attached refresh should recover the runtime before reloading the preview without cache',
  );
});

test('artifact events wait for their owning chat instead of being lost during concurrent tab navigation', () => {
  const artifactPanelSource = fs.readFileSync(artifactPanelPath, 'utf8');
  const artifactIndicatorSource = fs.readFileSync(artifactIndicatorPath, 'utf8');

  assert.match(
    artifactPanelSource,
    /this\.pendingArtifactOpensByChatId = new Map\(\);/,
    'the panel should retain artifact events whose owning chat is temporarily not loaded',
  );
  assert.match(
    artifactPanelSource,
    /queuePendingArtifactOpen\(data\)[\s\S]*pendingArtifactOpensByChatId\.set\(chatId, queued\)/s,
    'pending artifact events should be queued by explicit chat ownership',
  );
  assert.match(
    artifactPanelSource,
    /handleTabChatLoaded\(tabKey, chatId\)[\s\S]*pendingArtifactOpensByChatId\.delete\(normalizedChatId\)[\s\S]*routeArtifactOpen\(data, \{[\s\S]*targetTabKey: tabKey,[\s\S]*queueIfUnavailable: false/s,
    'loading the matching chat should atomically drain only that chat\'s queued artifact events',
  );
  assert.match(
    artifactPanelSource,
    /onArtifactOpen\(\(data\) => \{[\s\S]*void this\.routeArtifactOpen\(data\);/s,
    'incoming artifact events should use the queued chat-aware router',
  );
  assert.match(
    artifactIndicatorSource,
    /this\.webviewChatIds\.set\(webview, chatId\);[\s\S]*artifactPanel\?\.handleTabChatLoaded\?\.\(tabKey, chatId\);/s,
    'chat navigation should notify the panel when a concrete OWUI chat becomes available',
  );
});

test('artifact panel only attaches and restores previews for tabs loaded on the target OWUI chat', () => {
  const artifactPanelSource = fs.readFileSync(artifactPanelPath, 'utf8');

  assert.match(
    artifactPanelSource,
    /function getChatWebviewForArtifactTab\(tabKey = getActiveArtifactTabKey\(\)\)[\s\S]*conversation-webview-\$\{conversationId\}[\s\S]*return document\.getElementById\('chat-webview'\);/s,
    'artifact panel should resolve the live OWUI webview for the shell tab key',
  );
  assert.match(
    artifactPanelSource,
    /getLoadedChatIdForWebview\(webview\)\s*\{[\s\S]*if \(!webview\)[\s\S]*return null;[\s\S]*return this\.extractChatIdFromUrl\(webview\);[\s\S]*\}/s,
    'loaded chat identity should come from the live webview URL, not shell tab metadata',
  );
  assert.match(
    artifactPanelSource,
    /isAttachedStateValidForTab\(tabKey, state = this\.getAttachedState\(tabKey\)\)[\s\S]*state\?\.artifact\?\.chat_id[\s\S]*this\.isTabLoadedForChat\(tabKey, attachedChatId\)/s,
    'attached artifact state should be valid only when its chat_id matches the tab loaded chat',
  );
  assert.match(
    artifactPanelSource,
    /resolveTabKeyForChatId\(chatId\)[\s\S]*if \(!normalizedChatId\)[\s\S]*getLoadedChatIdForTabKey\(activeTab\)[\s\S]*return this\.isTabLoadedForChat\(activeTab, normalizedChatId\) \? activeTab : null;/s,
    'tab resolution must only fall back to the active tab when that tab is loaded for the requested chat',
  );
  assert.doesNotMatch(
    artifactPanelSource,
    /conversationId === normalizedChatId/,
    'a synthetic conversation tab id must not be treated as proof of loaded OWUI chat identity',
  );
  assert.match(
    artifactPanelSource,
    /getCurrentSlotForChat\(chatId\)[\s\S]*return this\.isAttachedStateValidForTab\(tabKey, state\) \? state : null;/s,
    'current-slot lookup should ignore stale slots for tabs no longer loaded on that chat',
  );
  assert.match(
    artifactPanelSource,
    /canAttachArtifactToChat\(chatId = null, artifactId = null\)[\s\S]*if \(!tabKey\)[\s\S]*return false;[\s\S]*if \(!this\.isAttachedStateValidForTab\(tabKey, state\)\)[\s\S]*return true;/s,
    'attach checks should reject missing loaded-chat targets while treating stale slots as unoccupied',
  );
  assert.match(
    artifactPanelSource,
    /activateForCurrentTab\(tabKey = getActiveArtifactTabKey\(\)\)[\s\S]*if \(!state\?\.artifact \|\| !this\.isAttachedStateValidForTab\(tabKey, state\)\)[\s\S]*hideActiveChrome\(\{ destroyView: false \}\)/s,
    'activating a tab should hide the attached preview when the tab is not loaded on the artifact chat',
  );
  assert.match(
    artifactPanelSource,
    /async open\(artifactId, previewUrl, name, version = null, chatId = null, options = \{\}\)[\s\S]*chatId = this\.getActiveLoadedChatId\(\);[\s\S]*if \(!tabKey \|\| !this\.isTabLoadedForChat\(tabKey, chatId\)\)[\s\S]*return;/s,
    'artifact-open without chat_id should attach only when the active tab has a loaded OWUI chat',
  );
});

test('artifact panel treats unsafe preview ports as recoverable fallback loads', () => {
  const artifactPanelSource = fs.readFileSync(artifactPanelPath, 'utf8');

  assert.match(
    artifactPanelSource,
    /const ARTIFACT_RECOVERABLE_PREVIEW_ERROR_CODES = new Set\(\[-102, -312\]\);/,
    'artifact panel should recover from connection-refused and ERR_UNSAFE_PORT preview failures',
  );
  assert.match(
    artifactPanelSource,
    /const ARTIFACT_ERR_UNSAFE_PORT = -312;/,
    'artifact panel should name the Electron ERR_UNSAFE_PORT error code',
  );
  assert.match(
    artifactPanelSource,
    /skipLiveProbe:\s*event\.errorCode === ARTIFACT_ERR_UNSAFE_PORT/s,
    'unsafe ports should go directly to materialized artifact fallback instead of probing the blocked port',
  );
  assert.match(
    artifactPanelSource,
    /if \(!options\.skipLiveProbe && port && window\.electronAPI\?\.artifacts\?\.pingServers\)/,
    'live-port health probes should be skipped for unsafe browser ports',
  );
});

test('artifact version switches load immutable version preview URLs', () => {
  const artifactPanelSource = fs.readFileSync(artifactPanelPath, 'utf8');
  const ipcSource = fs.readFileSync(ipcPath, 'utf8');
  const apiSource = fs.readFileSync(apiPath, 'utf8');

  assert.match(
    artifactPanelSource,
    /getVersionPreviewUrl\(version, artifact = this\.currentArtifact\)[\s\S]*\/versions\/\$\{versionNumber\}\//s,
    'docked artifact panel should build version-addressed snapshot preview URLs',
  );
  assert.match(
    artifactPanelSource,
    /safeLoadWebview\(url, options = \{\}\)\s*\{[\s\S]*this\.webview\.loadURL\(url, options\)/s,
    'docked artifact preview loads should pass reload options through to the webview/native facade',
  );
  assert.match(
    artifactPanelSource,
    /const versionPreviewUrl = this\.getVersionPreviewUrl\(version\);[\s\S]*const nextPreviewUrl = versionPreviewUrl \|\| livePreviewUrl;[\s\S]*safeLoadWebview\(nextPreviewUrl, versionLoadOptions\)/s,
    'manual docked version switches should prefer immutable snapshot URLs over live host ports',
  );
  assert.match(
    artifactPanelSource,
    /async updateVersion\(version, previewUrl, hostPort = null\)[\s\S]*const versionPreviewUrl = this\.getVersionPreviewUrl\(version\);[\s\S]*this\.currentArtifact\.preview_url = versionPreviewUrl;[\s\S]*safeLoadWebview\(this\.currentArtifact\.preview_url, \{\s*forceLoad: true,\s*bypassCache: true,\s*\}\);/s,
    'backend version-change events should reload from version-addressed snapshot URLs',
  );
  assert.match(
    ipcSource,
    /function getVersionPreviewUrl\(version\)[\s\S]*\/versions\/' \+[\s\S]*versionNumber \+ '\/';/s,
    'detached artifact windows should build version-addressed snapshot preview URLs',
  );
  assert.match(
    ipcSource,
    /function safeLoadUrl\(url, options = \{\}\)\s*\{[\s\S]*webview\.loadURL\(url, options\)/s,
    'detached artifact windows should pass reload options through to their webview',
  );
  assert.match(
    ipcSource,
    /const url = getVersionPreviewUrl\(newVersion\) \|\| liveUrl;[\s\S]*safeLoadUrl\(url, \{ forceLoad: true, bypassCache: true \}\);/,
    'detached version switches should prefer immutable snapshot URLs over live host ports',
  );
  assert.match(
    ipcSource,
    /!isVersionPreviewUrl\(ARTIFACT_DATA\.previewUrl\)[\s\S]*ARTIFACT_DATA\.previewUrl = liveUrl;/s,
    'detached running-version refresh should not overwrite immutable version preview URLs with live ports',
  );
  assert.match(
    ipcSource,
    /artifact-sync-detached-version"[\s\S]*previewUrl = null[\s\S]*windowInfo\.previewUrl = previewUrl;/s,
    'detached version sync should preserve the selected version preview URL for reattach',
  );
  assert.match(
    apiSource,
    /const \{ artifact_id, version, preview_url, host_port \} = req\.body;[\s\S]*window\.webContents\.send\('artifact-version-changed', \{[\s\S]*host_port/s,
    'version-change broadcasts should retain host_port so renderers reload the exact live preview URL',
  );
});

test('native artifact view bridge preserves force-load and cache-bypass options', () => {
  const artifactViewsSource = fs.readFileSync(artifactViewsPath, 'utf8');
  const artifactViewHostSource = fs.readFileSync(artifactViewHostPath, 'utf8');
  const preloadSource = fs.readFileSync(preloadPath, 'utf8');
  const ipcSource = fs.readFileSync(ipcPath, 'utf8');

  assert.match(
    artifactViewsSource,
    /async function clearArtifactSessionCache\(\)\s*\{[\s\S]*artifactSession\.clearCache/s,
    'artifact native views should expose a cache-clearing helper for version reloads',
  );
  assert.match(
    artifactViewsSource,
    /async function maybeLoadUrl\(entry, url, options = \{\}\)\s*\{[\s\S]*if \(options\.bypassCache\)\s*\{\s*await clearArtifactSessionCache\(\);/s,
    'artifact native views should clear the persistent artifact session cache when requested',
  );
  assert.match(
    artifactViewsSource,
    /options\.forceLoad[\s\S]*await maybeLoadUrl\(entry, targetUrl, options\);/s,
    'create/adopt should honor forceLoad so same-URL version restores still navigate',
  );
  assert.match(
    artifactViewsSource,
    /async function loadUrl\(viewKey, url, options = \{\}\)\s*\{[\s\S]*await maybeLoadUrl\(entry, url \|\| "about:blank", options\);/s,
    'direct native view URL loads should pass reload options into maybeLoadUrl',
  );
  assert.match(
    artifactViewHostSource,
    /artifactView\.loadUrl\([\s\S]*state\.viewKey,[\s\S]*explicitUrl,[\s\S]*forceLoad: Boolean\(options\.forceLoad\),[\s\S]*bypassCache: Boolean\(options\.bypassCache\),/s,
    'renderer native-view host should send forceLoad and bypassCache through pending create loads',
  );
  assert.match(
    artifactViewHostSource,
    /if \(options\.forceLoad\)\s*\{\s*viewOptions\.forceLoad = true;[\s\S]*if \(options\.bypassCache\)\s*\{\s*viewOptions\.bypassCache = true;/s,
    'renderer native-view host should include reload options in create/adopt payloads',
  );
  assert.match(
    artifactViewHostSource,
    /element\.loadURL = \(url, options = \{\}\) => loadUrl\(state, url, options\);/,
    'native webview facade should accept Electron-style loadURL options',
  );
  assert.match(
    preloadSource,
    /loadUrl:\s*async \(viewKey, url, options = \{\}\) => \{[\s\S]*ipcRenderer\.invoke\('artifact-view-load-url', \{ viewKey, url, options \}\)/s,
    'preload should bridge artifact load options to main IPC',
  );
  assert.match(
    ipcSource,
    /ipcMain\.handle\("artifact-view-load-url", async \(_event, \{ viewKey, url, options = \{\} \} = \{\}\) => \{[\s\S]*artifactViews\.loadUrl\(viewKey, url, options\)/s,
    'main IPC should forward artifact load options into the native view service',
  );
});

test('artifact indicator clears landing-page artifact badges and avoids global chat fallbacks', () => {
  const artifactIndicatorSource = fs.readFileSync(artifactIndicatorPath, 'utf8');

  assert.match(
    artifactIndicatorSource,
    /onArtifactOpen\(\(data\) => \{[\s\S]*chatId = this\.getLoadedChatIdForTabKey\(window\.appState\?\.activeTab \|\| 'chat'\);[\s\S]*Ignoring artifact-open without a loaded target chat/s,
    'artifact-open events without chat_id should use only the active loaded chat and otherwise be ignored',
  );
  assert.doesNotMatch(
    artifactIndicatorSource,
    /data\.chatId \|\| this\.currentChatId/,
    'detached artifact events should not fall back to the global currentChatId',
  );
  assert.match(
    artifactIndicatorSource,
    /getLoadedChatIdForWebview\(webview\)[\s\S]*const url = \(typeof webview\.getURL === 'function' \? webview\.getURL\(\) : null\) \|\| webview\.src;[\s\S]*return this\.extractChatIdFromUrl\(url\);/s,
    'loaded chat helpers should derive identity from the live webview URL',
  );
  assert.match(
    artifactIndicatorSource,
    /handleWebviewLeftChat\(webview, previousChatId, reason\)[\s\S]*artifactPanel\?\.handleTabChatChanged\?\.\(tabKey, previousChatId, null\)[\s\S]*this\.notifyWebviewOfArtifactsForWebview\(webview\);/s,
    'navigating to the landing page should clear the tab panel slot and send an explicit update to that OWUI host',
  );
  assert.match(
    artifactIndicatorSource,
    /buildArtifactUpdateForChat\(chatId\)[\s\S]*if \(!chatId\)[\s\S]*chatId: null,[\s\S]*count: 0,[\s\S]*artifacts: \[\]/s,
    'landing-page OWUI hosts should receive an explicit zero-artifact badge update',
  );
  assert.match(
    artifactIndicatorSource,
    /notifyWebviewOfArtifacts\(chatId = this\.currentChatId\)[\s\S]*const targetChatId = this\.getLoadedChatIdForWebview\(webview\);[\s\S]*const data = this\.buildArtifactUpdateForChat\(targetChatId\);/s,
    'artifact notifications should be scoped to the loaded chat in each webview',
  );
  assert.doesNotMatch(
    artifactIndicatorSource,
    /webview\.id === 'chat-webview' \? this\.currentChatId : null/,
    'artifact notifications must not reuse global currentChatId for a landing-page main webview',
  );
  assert.doesNotMatch(
    artifactIndicatorSource,
    /API returned empty but keeping/,
    'empty artifact-list API responses should clear stale local artifact badges',
  );
});

test('preload exposes native artifact menu and divider overlay bridges to the main renderer', () => {
  const preloadSource = fs.readFileSync(preloadPath, 'utf8');

  assert.match(
    preloadSource,
    /artifactVersionMenu:\s*\{[\s\S]*ipcRenderer\.invoke\('artifact-version-menu-show'[\s\S]*ipcRenderer\.on\('artifact-version-menu-event'/s,
    'preload should expose artifactVersionMenu show/hide/event APIs',
  );
  assert.match(
    preloadSource,
    /artifactDividerOverlay:\s*\{[\s\S]*ipcRenderer\.invoke\('artifact-divider-overlay-sync'[\s\S]*ipcRenderer\.on\('artifact-divider-overlay-event'/s,
    'preload should expose artifactDividerOverlay sync/hide/event APIs',
  );
});

test('artifact panel exposes a publish action through preload and IPC', () => {
  const artifactPanelSource = fs.readFileSync(artifactPanelPath, 'utf8');
  const indexHtmlSource = fs.readFileSync(indexHtmlPath, 'utf8');
  const preloadSource = fs.readFileSync(preloadPath, 'utf8');
  const ipcSource = fs.readFileSync(path.join(repoRoot, 'electron-app', 'src', 'services', 'ipc.js'), 'utf8');

  assert.match(
    indexHtmlSource,
    /id="artifact-publish-btn"[\s\S]*Publish[\s\S]*id="artifact-publish-status"/s,
    'artifact panel header should include a Publish button and status surface',
  );
  assert.match(
    artifactPanelSource,
    /async publish\(\)[\s\S]*window\.electronAPI\.artifacts\.publish\(\{[\s\S]*artifactId:[\s\S]*chatId:[\s\S]*version:/s,
    'artifact panel should publish the current artifact through the artifacts preload bridge',
  );
  assert.match(
    artifactPanelSource,
    /Published to Prototype Hub\. Build takes ~5 min\./,
    'successful publish status should briefly tell users the prototype is still building',
  );
  assert.match(
    artifactPanelSource,
    /document\.createElement\('a'\)[\s\S]*link\.textContent = linkText/s,
    'successful publish status should hyperlink the Prototype Hub URL',
  );
  assert.match(
    preloadSource,
    /publish:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('artifact-publish',\s*payload\)/,
    'preload should expose artifacts.publish',
  );
  assert.match(
    ipcSource,
    /ipcMain\.handle\(\s*"artifact-publish"[\s\S]*\{ artifactId, chatId, name, version \}[\s\S]*publishArtifactToPrototypes\(\{[\s\S]*version,/s,
    'main IPC should pass the selected artifact version to the Prototypes publisher service',
  );
});

test('artifact panel uses the landing-page visual language without changing its controls', () => {
  const indexHtmlSource = fs.readFileSync(indexHtmlPath, 'utf8');
  const stylesSource = fs.readFileSync(stylesPath, 'utf8');
  const artifactPanelSource = fs.readFileSync(artifactPanelPath, 'utf8');

  assert.match(
    indexHtmlSource,
    /class="artifact-title-mark"[\s\S]*id="artifact-name"[\s\S]*id="version-dropdown-trigger"/s,
    'artifact identity and version controls should remain grouped in the polished header',
  );
  assert.match(
    stylesSource,
    /\.artifact-panel\s*\{[\s\S]*--artifact-canvas:[\s\S]*--artifact-header-surface:[\s\S]*container-type:\s*inline-size;/s,
    'artifact panel should own a theme-aware canvas and support pane-local responsive styling',
  );
  assert.match(
    stylesSource,
    /\[data-theme="light"\] \.artifact-panel\s*\{[\s\S]*--artifact-canvas:\s*#f7f7f7;[\s\S]*--artifact-header-surface:\s*rgba\(250, 250, 250, 0\.98\);/s,
    'light artifact panes should match the off-white landing canvas rather than the old blue-grey slab',
  );
  assert.match(
    stylesSource,
    /\.version-dropdown-trigger\s*\{[\s\S]*border-radius:\s*999px;[\s\S]*box-shadow:\s*var\(--artifact-contact-shadow\);[\s\S]*max-width:\s*clamp\(108px, 13vw, 180px\);/s,
    'version selection should use a quiet, bounded pill that cannot crowd out the artifact title',
  );
  assert.match(
    stylesSource,
    /\.artifact-publish-btn\s*\{[\s\S]*background:\s*var\(--text-primary\);[\s\S]*border-radius:\s*999px;/s,
    'Publish should read as the restrained primary action in both themes',
  );
  assert.match(
    stylesSource,
    /@container \(max-width:\s*520px\)[\s\S]*\.artifact-panel-header\s*\{[\s\S]*flex-wrap:\s*wrap;/s,
    'narrow artifact panes should reflow instead of clipping or dropping controls',
  );
  assert.match(
    artifactPanelSource,
    /const fullVersionLabel = currentVersion\.version_note[\s\S]*this\.versionText\.textContent = `v\$\{currentVersion\.version\}`;[\s\S]*setAttribute\('aria-label', `Select version: \$\{fullVersionLabel\}`\)/s,
    'the compact trigger should show only the version while retaining its full note for accessibility and the native menu',
  );
});

test('windows service provisions interactive native windows for the artifact version menu and divider overlay', () => {
  const windowsSource = fs.readFileSync(windowsPath, 'utf8');

  assert.match(
    windowsSource,
    /state\.windows\.artifactVersionMenu[\s\S]*focusable:\s*true[\s\S]*artifact-version-menu-preload\.js[\s\S]*artifact-version-menu\.html/s,
    'windows service should create an interactive child BrowserWindow for the artifact version menu',
  );
  assert.match(
    windowsSource,
    /state\.windows\.artifactDividerOverlay[\s\S]*focusable:\s*false[\s\S]*artifact-divider-overlay-preload\.js[\s\S]*artifact-divider-overlay\.html/s,
    'windows service should create a transparent child BrowserWindow for the artifact divider overlay',
  );
  assert.match(
    windowsSource,
    /function isArtifactVersionMenuFocusedForOwner\(ownerWindow\)\s*\{[\s\S]*BrowserWindow\.getFocusedWindow\(\)[\s\S]*focusedWindow\.id === menuWindow\.id;/s,
    'windows service should detect when focus moved into the artifact version menu child window',
  );
  assert.match(
    windowsSource,
    /function bindArtifactDividerOverlayOwnerLifecycle\(parentWindow\)\s*\{[\s\S]*setTimeout\(\(\) => \{[\s\S]*isArtifactVersionMenuFocusedForOwner\(ownerWindow\)[\s\S]*return;[\s\S]*hideArtifactDividerOverlay\(\{[\s\S]*reason:\s*'parent-blur'/s,
    'divider overlay blur handling should ignore internal focus moves into the artifact version menu child',
  );
  assert.match(
    windowsSource,
    /artifactDividerOverlayState\.ownerLifecycleCleanup\s*=\s*bindArtifactDividerOverlayOwnerLifecycle\(parentWindow\);/s,
    'divider overlay lifecycle should use the guarded owner blur handler',
  );
  assert.doesNotMatch(
    windowsSource,
    /bindOwnerLifecycle\(\s*parentWindow,\s*\[\s*'blur',\s*'minimize',\s*'closed'\s*\]/,
    'divider overlay should no longer hide on every parent blur without checking the focused child window',
  );
  assert.match(
    windowsSource,
    /function beginArtifactDividerDrag\(payload = \{\}\)\s*\{[\s\S]*overlayWindow\.setBounds\(ownerWindow\.getContentBounds\(\)\)/s,
    'divider drag should expand the overlay into a full drag shield while the drag is active',
  );
  assert.match(
    windowsSource,
    /const ARTIFACT_DIVIDER_OVERLAY_MIN_WIDTH = 6;/,
    'divider overlay minimum width should match the renderer divider width',
  );
  assert.match(
    windowsSource,
    /clampLocalBoundsToContent\(parentWindow, bounds, \{\s*width:\s*ARTIFACT_DIVIDER_OVERLAY_MIN_WIDTH,\s*height:\s*24,/s,
    'divider overlay sync should clamp to the shared 6px divider width constant',
  );
});

test('artifact styles keep a full drag target around a subtle seam without preview inset hacks', () => {
  const stylesSource = fs.readFileSync(stylesPath, 'utf8');

  assert.match(
    stylesSource,
    /\.artifact-divider\s*\{[^}]*width:\s*6px;[^}]*background:\s*linear-gradient\([\s\S]*var\(--border-default\)[\s\S]*\);[^}]*touch-action:\s*none;[^}]*\}/s,
    'artifact divider should retain its 6px drag target while drawing only a quiet one-pixel seam',
  );
  assert.match(
    stylesSource,
    /\.artifact-divider::before\s*\{[^}]*top:\s*50%;[^}]*transform:\s*translate\(-50%, -50%\);[^}]*width:\s*2px;[^}]*height:\s*40px;[^}]*background:\s*var\(--text-secondary\);[^}]*opacity:\s*0;[^}]*transition:\s*opacity 0\.15s ease;[^}]*\}/s,
    'artifact divider should use the same centered 2px by 40px hover handle cue as the tool config modal',
  );
  assert.match(
    stylesSource,
    /\.artifact-divider:hover,\s*\.artifact-divider\.hovering,\s*\.artifact-divider\.dragging\s*\{\s*background:\s*linear-gradient\([\s\S]*var\(--accent-primary\)[\s\S]*\);/s,
    'artifact divider hover, native-overlay hover, and drag states should accent the seam without filling the hit target',
  );
  assert.match(
    stylesSource,
    /\.artifact-divider:hover::before,\s*\.artifact-divider\.hovering::before,\s*\.artifact-divider\.dragging::before\s*\{\s*opacity:\s*0\.5;/s,
    'artifact divider hover, native-overlay hover, and drag states should reveal the centered handle cue',
  );
  assert.doesNotMatch(
    stylesSource,
    /artifact-dropdown-preview-inset/,
    'artifact preview host styling should not include the old dropdown inset workaround',
  );
});
