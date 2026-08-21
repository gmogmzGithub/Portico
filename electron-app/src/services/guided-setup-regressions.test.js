const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

test("About dialog uses packaged build-origin channel while release channel menu item stays separate", () => {
  const source = readRepoFile("electron-app/src/services/bootstrap.js");

  assert.match(
    source,
    /const aboutChannelLabel = getResolvedBuildChannelInfo\(state\.buildInfo\)\.label;/,
  );
  assert.match(source, /Channel: \$\{aboutChannelLabel\}/);
  assert.match(source, /label: `Release Channel: \$\{channelLabel\}`/);
});

test("guided setup hello stage ships bundled curated logo fallbacks", () => {
  const source = readRepoFile("electron-app/src/renderer/views/guided-setup.js");

  assert.match(source, /const HELLO_LOGO_ASSET_BASE = '\.\.\/assets\/hello-logos';/);
  assert.match(source, /assetPath: `\$\{HELLO_LOGO_ASSET_BASE\}\/glean\.png`/);
  assert.match(source, /assetPath: `\$\{HELLO_LOGO_ASSET_BASE\}\/google-workspace\.png`/);
  assert.match(source, /assetPath: `\$\{HELLO_LOGO_ASSET_BASE\}\/atlassian\.png`/);
  assert.match(source, /assetPath: `\$\{HELLO_LOGO_ASSET_BASE\}\/portico\.png`/);
  assert.match(source, /serverIds: \['data-plat-mcp'\]/);
  assert.doesNotMatch(source, /Data Platform, Teamworks, and Team Ownership/);
});

test("guided setup prerequisite recovery uses packaged password guidance asset", () => {
  const html = readRepoFile("electron-app/src/renderer/views/guided-setup.html");
  const assetPath = path.join(
    REPO_ROOT,
    "electron-app/assets/setup-guidance/sudo-password.png",
  );

  assert.match(html, /src="\.\.\/assets\/setup-guidance\/sudo-password\.png"/);
  assert.doesNotMatch(html, /skills\/host-mode-setup/);
  assert.equal(fs.existsSync(assetPath), true);
});

test("guided setup hello stage remembers the saved mode and labels the screen as Welcome", () => {
  const html = readRepoFile("electron-app/src/renderer/views/guided-setup.html");
  const source = readRepoFile("electron-app/src/renderer/views/guided-setup.js");
  const css = readRepoFile("electron-app/src/renderer/views/guided-setup.css");

  assert.match(html, /<div class="hello-eyebrow">Welcome<\/div>/);
  assert.match(html, /id="hello-mode-error"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(
    source,
    /setupState\.savedOnboardingMode = normalizeOnboardingModeSelection\(\s*bootstrapState\?\.savedOnboardingMode,\s*\)/s,
  );
  assert.match(
    source,
    /function getRememberedHelloMode\(\)\s*\{\s*return normalizeOnboardingModeSelection\(setupState\.savedOnboardingMode\);\s*\}/s,
  );
  assert.match(source, /function setHelloModeError\(message = null\)/);
  assert.match(source, /syncHelloModeSelectionUI\(selectedMode = getRememberedHelloMode\(\)\)/);
  assert.match(source, /option\.classList\.toggle\('is-selected', isSelected\);/);
  assert.match(source, /window\.electronAPI\?\.saveGuidedSetupModePreference\?\.\(mode\)/);
  assert.match(css, /\.hello-mode-error\s*\{[^}]*color:\s*var\(--status-error\);/s);
  assert.match(css, /\.hello-option-card\s*\{[^}]*overflow:\s*visible;/s);
  assert.match(css, /\.hello-option-card\.is-selected\s*\{[^}]*box-shadow:[^}]*inset 0 0 0 2px rgba\(79,\s*148,\s*255,\s*0\.44\);/s);
  assert.match(css, /\.hello-option-card\.is-selected::after\s*\{[^}]*content:\s*"Selected";/s);
});

test("guided setup hello stage only remembers a mode after persistence succeeds", () => {
  const source = readRepoFile("electron-app/src/renderer/views/guided-setup.js");

  assert.match(source, /const previousSavedMode = setupState\.savedOnboardingMode;/);
  assert.match(source, /savePreferenceResult\?\.success !== true/);
  assert.match(source, /setupState\.savedOnboardingMode = previousSavedMode;/);
  assert.match(source, /setHelloModeError\(errorMessage\);/);
  assert.match(source, /return;\s*\}\s*\n\s*\n\s*setupState\.savedOnboardingMode = mode;/s);
});

test("guided setup server selection stage uses a proper title block and right-aligned actions", () => {
  const html = readRepoFile("electron-app/src/renderer/views/guided-setup.html");
  const css = readRepoFile("electron-app/src/renderer/views/guided-setup.css");
  const source = readRepoFile("electron-app/src/renderer/screens/guided-setup/screen-server-selection.js");

  assert.match(html, /id="server-selection-loading-shell"/);
  assert.match(html, /Loading your integrations\.\.\./);
  assert.match(html, /id="server-selection-ready-content"/);
  assert.match(html, /class="server-selection-copy"/);
  assert.match(html, /<div class="hello-eyebrow server-selection-stage-title">Choose Integrations<\/div>/);
  assert.match(html, /class="server-selection-subtitle server-selection-stage-subtitle"/);
  assert.match(html, /class="server-selection-toolbar"/);
  assert.match(html, /class="button-group server-selection-actions"[\s\S]*class="server-selection-link"[^>]*id="select-all-btn"[^>]*aria-pressed="false"[\s\S]*id="skip-integrations-btn"[\s\S]*data-tooltip="You can always configure more integrations later\."[\s\S]*id="proceed-btn"/s);
  assert.doesNotMatch(html, /class="bottom-button-group"/);
  assert.match(css, /#stage-server-selection\.active\s*\{[^}]*padding-top:\s*0\.85rem;/s);
  assert.match(css, /#stage-server-selection\.active\.is-loading\s*\{[^}]*justify-content:\s*center;[^}]*padding-top:\s*0;/s);
  assert.match(css, /#stage-server-selection\s+\.server-selection-loading-shell\s*\{[^}]*display:\s*none;[^}]*justify-content:\s*center;/s);
  assert.match(css, /#stage-server-selection\.is-loading\s+\.server-selection-loading-shell\s*\{[^}]*display:\s*flex;/s);
  assert.match(css, /#stage-server-selection\.is-loading\s+\.server-selection-ready-content\s*\{[^}]*display:\s*none;/s);
  assert.match(css, /#stage-server-selection\s+\.server-selection-copy\s*\{[^}]*padding-top:\s*0\.25rem;[^}]*margin-bottom:\s*0\.75rem;/s);
  assert.match(css, /#stage-server-selection\s+\.server-selection-stage-title\s*\{[^}]*margin-bottom:\s*0\.42rem;/s);
  assert.match(css, /#stage-server-selection\s+\.server-selection-stage-subtitle\s*\{[^}]*font-size:\s*0\.9rem;[^}]*line-height:\s*1\.55;/s);
  assert.match(css, /#stage-server-selection\s+\.server-selection-toolbar\s*\{[^}]*justify-content:\s*space-between;[^}]*margin:\s*0;/s);
  assert.match(css, /\.server-selection-link\s*\{[^}]*background:\s*none;[^}]*color:\s*var\(--accent-primary\);[^}]*font-size:\s*0\.8125rem;/s);
  assert.match(css, /#stage-server-selection\s+\.server-selection-actions\s*\{[^}]*justify-content:\s*flex-end;[^}]*margin-left:\s*auto;/s);
  assert.match(css, /#stage-server-selection\s+\.server-selection-actions\s+\.btn\s*\{[^}]*min-height:\s*40px;[^}]*border-radius:\s*0\.75rem;/s);
  assert.match(css, /#stage-server-selection\s+#skip-integrations-btn\[data-tooltip\]::after\s*\{[^}]*bottom:\s*calc\(100%\s*\+\s*8px\);[^}]*left:\s*50%;[^}]*transform:\s*translateX\(-50%\);/s);
  assert.match(css, /\[data-theme="light"\]\s+#stage-server-selection\s+\.server-selection-actions\s+\.btn-skip\s*\{[^}]*background:\s*#d9e1ec;[^}]*color:\s*#334155;/s);
  assert.doesNotMatch(css, /#stage-server-selection\s+#proceed-btn\s*\{\s*display:\s*none;/s);
  assert.match(css, /#stage-server-selection\s+\.server-grid\s*\{[^}]*margin:\s*0\.35rem 0 0;/s);
  assert.match(css, /#stage-server-selection\s+\.mcp-card-description\s*\{[^}]*font-size:\s*0\.5625rem;[^}]*color:\s*var\(--text-tertiary\);/s);
  assert.match(css, /\[data-theme="light"\]\s+#stage-server-selection\s+\.mcp-card-description\s*\{[^}]*color:\s*#5f6b7d;/s);
  assert.match(source, /const fragment = typeof document\.createDocumentFragment === 'function'/);
  assert.match(source, /fragment\.appendChild\(card\);/);
  assert.match(source, /serverGrid\.appendChild\(fragment\);/);
  assert.doesNotMatch(source, /btn\.classList\.toggle\('is-visible',\s*hasSelections\);/);
  assert.match(source, /btn\.textContent = allEligibleSelected\s*\?\s*'Deselect all'\s*:\s*'Select all';/s);
  assert.match(source, /btn\.setAttribute\('aria-pressed', allEligibleSelected \? 'true' : 'false'\);/);
});

test("guided setup power-mode integrations hydrate raw toggles and reconcile selections by server id", () => {
  const source = readRepoFile("electron-app/src/renderer/views/guided-setup.js");
  const helperSource = readRepoFile("electron-app/src/services/guided-setup/server-selection-state.js");

  assert.match(source, /const preservedSelectedServerIds = getSelectedServerIdsFromIndices\(/);
  assert.match(source, /setupState\.selectedServers = getSelectedServerIndicesFromIds\(/);
  assert.match(source, /async function loadGuidedSetupHealthStatus\(\)/);
  assert.match(source, /async function hydrateServerSelectionFromCurrentToggles\(\)/);
  assert.match(source, /setupState\.onboardingMode !== 'power' \|\| setupState\.serverSelectionHydrated === true/);
  assert.match(source, /const toggles = await loadGuidedSetupToggleBaseline\(\);/);
  assert.match(source, /setupState\.launchContext\?\.seedDefaults === true/);
  assert.match(source, /setupState\.selectedServers = getHydratedGuidedSetupSelectionIndices\(/);
  assert.match(
    source,
    /getSelectedServerIndicesFromIds\(\s*setupState\.mcpServers,\s*\[\.\.\.currentSelectedIds,\s*\.\.\.defaultSelectedIds\],\s*\)/s,
  );
  assert.match(source, /toggles,/);
  assert.match(source, /setupState\.serverSelectionHydrated = true;/);
  assert.match(source, /const result = await window\.electronAPI\.loadGuidedSetupMcpToggles\(\);/);
  assert.match(source, /recordGuidedSetupToggleChange\(setupState, serverId, true\);/);
  assert.match(helperSource, /function isGuidedSetupEffectivelyEnabledServer\(/);
  assert.match(helperSource, /return toggles\?\.\[server\.id\] === true;/);
  assert.doesNotMatch(helperSource, /backendStatus/);
  assert.match(helperSource, /function applyGuidedSetupSelectionToToggles\(/);
});

test("guided setup light-mode setup badges use darker text without changing dark-mode badge colors", () => {
  const css = readRepoFile("electron-app/src/renderer/views/guided-setup.css");

  assert.match(css, /--badge-oauth-text:\s*#e9d5ff;/);
  assert.match(css, /--badge-config-text:\s*#93c5fd;/);
  assert.match(
    css,
    /\[data-theme="light"\]\s*\{[\s\S]*--badge-oauth-text:\s*#5b21b6;[\s\S]*--badge-config-text:\s*#1d4ed8;/,
  );
});

test("guided setup debug drawer only opens from the explicit bug-button handler", () => {
  const viewSource = readRepoFile("electron-app/src/renderer/views/guided-setup.js");
  const prereqSource = readRepoFile(
    "electron-app/src/renderer/screens/guided-setup/screen-prerequisites.js",
  );

  const drawerOpenCalls =
    viewSource.match(/showGuidedSetupDebugDrawer\(\{ refresh: true \}\)/g) || [];

  assert.equal(
    drawerOpenCalls.length,
    1,
    "expected exactly one explicit guided setup drawer open path",
  );
  assert.match(
    viewSource,
    /elements\.toggle\.addEventListener\('click', \(\) => \{\s+if \(guidedSetupDebugState\.drawerOpen\)/s,
  );
  assert.doesNotMatch(viewSource, /type === 'error'/);
  assert.doesNotMatch(prereqSource, /autoOpenDebugDrawer/);
});

test("guided setup dev-only error-state tester is hidden in static markup", () => {
  const htmlSource = readRepoFile("electron-app/src/renderer/views/guided-setup.html");

  assert.match(
    htmlSource,
    /<details class="guided-setup-debug-test-panel" id="guided-setup-debug-test-panel"[^>]*hidden[^>]*aria-hidden="true"[^>]*style="display: none;"/,
  );
});

test("guided setup keeps a single shared titlebar action cluster with clickable theme and diagnostics controls", () => {
  const htmlSource = readRepoFile("electron-app/src/renderer/views/guided-setup.html");
  const cssSource = readRepoFile("electron-app/src/renderer/views/guided-setup.css");

  assert.match(
    htmlSource,
    /<div class="titlebar-actions">\s*<button class="theme-toggle" id="theme-toggle"[\s\S]*?<button class="debug-toggle" id="guided-setup-debug-toggle"/s,
  );
  assert.equal((htmlSource.match(/id="theme-toggle"/g) || []).length, 1);
  assert.equal((htmlSource.match(/id="guided-setup-debug-toggle"/g) || []).length, 1);
  assert.match(
    cssSource,
    /\.titlebar-actions\s*\{[^}]*-webkit-app-region:\s*no-drag;[^}]*position:\s*relative;[^}]*z-index:\s*1001;[^}]*pointer-events:\s*auto;/s,
  );
  assert.match(
    cssSource,
    /\.debug-toggle,\s*\.theme-toggle\s*\{[^}]*cursor:\s*pointer;[^}]*position:\s*relative;[^}]*z-index:\s*1002;[^}]*pointer-events:\s*auto;/s,
  );
});

test("guided setup stage window heights are centralized and explicit", () => {
  const source = readRepoFile("electron-app/src/renderer/views/guided-setup.js");
  const helperSource = readRepoFile("electron-app/src/renderer/views/guided-setup-stage-window.js");
  const cssSource = readRepoFile("electron-app/src/renderer/views/guided-setup.css");

  assert.match(source, /const\s+\{\s*getGuidedSetupStageWindowOptions\s*\}\s*=\s*require\('\.\/guided-setup-stage-window'\);/);
  assert.match(source, /const GUIDED_SETUP_WINDOW_DEFAULT_WIDTH = 1180;/);
  assert.match(source, /const GUIDED_SETUP_WINDOW_DEFAULT_HEIGHT = 820;/);
  assert.match(source, /const stageWindowOptions = getGuidedSetupStageWindowOptions\(resolvedStage,\s*setupState\);/);
  assert.match(source, /if \(stageWindowOptions\) \{\s*maximizeGuidedSetupWindow\(stageWindowOptions,\s*`showStage:\$\{resolvedStage\}`\);\s*\}/s);
  assert.match(source, /function getGuidedSetupWindowResizeTargets\(options = \{\}\) \{[\s\S]*targetWidth:[\s\S]*GUIDED_SETUP_WINDOW_DEFAULT_WIDTH[\s\S]*targetHeight:[\s\S]*GUIDED_SETUP_WINDOW_DEFAULT_HEIGHT/s);
  assert.match(source, /console\.log\(`\[guided-setup\] Resizing guided setup window: reason=\$\{reason\} targetWidth=\$\{targetWidth\} targetHeight=\$\{targetHeight\}`\);/);
  assert.match(source, /function setGuidedSetupStageLoadingState\(\{\s*stageId,\s*progressStageName,\s*loadingShellId,\s*readyContentId,\s*isLoading,\s*\}\) \{/s);
  assert.match(source, /if \(resolvedStage === 'server-selection'\) \{\s*setServerSelectionLoadingState\(true\);/s);
  assert.match(source, /if \(resolvedStage === 'oauth'\) \{\s*setOauthLoadingState\(true\);/s);
  assert.match(source, /if \(resolvedStage === 'configuration' && options\.initialLoading === true\) \{\s*setConfigurationLoadingState\(true\);/s);
  assert.match(source, /await loadMcpServerConfigs\(\);[\s\S]*await hydrateServerSelectionFromCurrentToggles\(\);[\s\S]*_populateServerGrid\(setupState,\s*callbacks\);[\s\S]*_updateSelectAllButtons\(setupState,\s*callbacks\);[\s\S]*setServerSelectionLoadingState\(false\);/s);
  assert.match(source, /if \(resolvedStage === 'oauth'\) \{\s*try \{\s*await _loadOAuthScreen\(setupState,\s*callbacks,\s*\{\s*suppressAutoAdvance:\s*options\.suppressOauthAutoAdvance === true,\s*autoStartPending:\s*options\.autoStartPendingOAuth === true,\s*\}\);[\s\S]*setOauthLoadingState\(false\);/s);
  assert.match(source, /function setServerSelectionLoadingState\(isLoading\) \{/);
  assert.match(source, /function setOauthLoadingState\(isLoading\) \{/);
  assert.match(source, /function setConfigurationLoadingState\(isLoading\) \{/);
  assert.match(source, /maximizeGuidedSetupWindow\(\{\},\s*'startSetup'\);/);
  assert.match(helperSource, /if \(stageName === 'hello'\) \{\s*return \{ targetWidth: 1180, targetHeight: 820 \};\s*\}/s);
  assert.match(helperSource, /if \(stageName === 'oauth'\) \{\s*return \{ targetHeight: 860 \};\s*\}/s);
  assert.match(helperSource, /if \(stageName === 'configuration'\) \{\s*return \{ targetHeight: 1080 \};\s*\}/s);
  assert.match(helperSource, /if \(stageName === 'finalize'\) \{\s*return \{ targetHeight: 800 \};\s*\}/s);
  assert.match(helperSource, /if \(stageName === 'server-selection' && setupState\?\.onboardingMode === 'power'\) \{\s*return \{ targetHeight: 880 \};\s*\}/s);
  assert.match(cssSource, /#stage-prerequisites\.active\s*\{[^}]*justify-content:\s*center;[^}]*padding-top:\s*2\.5rem;[^}]*padding-bottom:\s*2\.5rem;/s);
  assert.match(helperSource, /return null;/);
  assert.doesNotMatch(source, /restoreGuidedSetupWindow/);
});

test("the hello stage window width stays above the card-stacking breakpoint", () => {
  const helperSource = readRepoFile("electron-app/src/renderer/views/guided-setup-stage-window.js");
  const cssSource = readRepoFile("electron-app/src/renderer/views/guided-setup.css");
  const windowsSource = readRepoFile("electron-app/src/services/windows.js");

  // These three values are a single contract: below the media query width the
  // two mode cards collapse into one column, so both the birth size and the
  // stage target must clear it. Changing the breakpoint without the targets
  // (or vice versa) is what regressed this.
  const breakpoint = cssSource.match(/@media \(max-width: (\d+)px\)[\s\S]{0,200}?\.hello-options \{\s*grid-template-columns: 1fr;/);
  assert.ok(breakpoint, "expected the hello-options single-column media query");
  const maxStackedWidth = Number(breakpoint[1]);

  const stageWidth = Number(
    helperSource.match(/if \(stageName === 'hello'\) \{\s*return \{ targetWidth: (\d+)/s)?.[1],
  );
  assert.ok(stageWidth > maxStackedWidth, `hello stage width ${stageWidth} must exceed ${maxStackedWidth}`);

  // A 'full' launch renders hello immediately, so the window must be born wide
  // enough rather than animating into it.
  assert.match(windowsSource, /const startsOnHelloStage = options\?\.setupMode === 'full';/);
  const birthWidth = Number(
    windowsSource.match(/startsOnHelloStage\s*\?\s*\{ width: (\d+), height: (\d+) \}/)?.[1],
  );
  assert.ok(birthWidth > maxStackedWidth, `hello birth width ${birthWidth} must exceed ${maxStackedWidth}`);
  assert.equal(birthWidth, stageWidth, "birth width and stage target must agree");
});

test("guided setup oauth skip-for-now action keeps a destructive red treatment", () => {
  const cssSource = readRepoFile("electron-app/src/renderer/views/guided-setup.css");

  assert.match(cssSource, /\.oauth-skip-auth-btn\s*\{[^}]*background:\s*#b91c1c;[^}]*color:\s*#fff;/s);
  assert.match(cssSource, /\.oauth-skip-auth-btn:hover,\s*\.oauth-skip-auth-btn:focus-visible\s*\{[^}]*background:\s*#991b1b;[^}]*color:\s*#fff;/s);
});

test("guided setup short-height prerequisites spotlight remains vertically centered", () => {
  const cssSource = readRepoFile("electron-app/src/renderer/views/guided-setup.css");

  assert.match(
    cssSource,
    /@media \(max-height:\s*860px\)\s*\{[\s\S]*#stage-prerequisites\.active\s*\{[^}]*justify-content:\s*center;[^}]*padding-top:\s*2rem;[^}]*padding-bottom:\s*2rem;/s,
  );
});

test("guided setup configuration stage uses the connect-style shell and hides the legacy panel header", () => {
  const html = readRepoFile("electron-app/src/renderer/views/guided-setup.html");
  const css = readRepoFile("electron-app/src/renderer/views/guided-setup.css");
  const source = readRepoFile("electron-app/src/renderer/views/guided-setup.js");
  const parserSource = readRepoFile("electron-app/src/services/guided-setup/setup-markdown-parser.js");
  const confirmationSource = readRepoFile("electron-app/src/renderer/components/setup-confirmation.js");
  const accordionSource = readRepoFile("electron-app/src/renderer/components/setup-accordion.js");
  const screenSource = readRepoFile("electron-app/src/renderer/screens/guided-setup/screen-configuration.js");
  const progressSource = readRepoFile("electron-app/src/renderer/components/setup-progress.js");

  assert.match(html, /id="oauth-stage-loading-shell"/);
  assert.match(html, /Loading your connections\.\.\./);
  assert.match(html, /id="oauth-stage-ready-content"/);
  assert.match(css, /#stage-oauth\.active\.is-loading\s*\{[^}]*justify-content:\s*center;[^}]*padding-top:\s*0;/s);
  assert.match(css, /#stage-oauth\s+\.oauth-stage-loading-shell\s*\{[^}]*display:\s*none;[^}]*justify-content:\s*center;/s);
  assert.match(css, /#stage-oauth\.is-loading\s+\.oauth-stage-loading-shell\s*\{[^}]*display:\s*flex;/s);
  assert.match(css, /#stage-oauth\.is-loading\s+\.oauth-stage-ready-content\s*\{[^}]*display:\s*none;/s);
  assert.match(html, /id="configuration-stage-loading-shell"/);
  assert.match(html, /Loading your configuration\.\.\./);
  assert.match(html, /id="configuration-stage-ready-content"/);
  assert.match(html, /<h1 class="server-selection-header configuration-stage-header">Configure<\/h1>/);
  assert.match(html, /class="server-selection-subtitle configuration-stage-subtitle"/);
  assert.match(html, /class="configuration-stage-card"/);
  assert.match(html, /class="configuration-stage-card-header"/);
  assert.match(html, /id="configuration-card-title" class="configuration-stage-card-title">Configuration<\/h2>/);
  assert.match(
    html,
    /class="button-group configuration-stage-actions"[\s\S]*id="skip-server-btn"[\s\S]*>[\s\S]*Skip[\s\S]*<\/button>[\s\S]*id="skip-all-servers-btn"[\s\S]*>[\s\S]*Skip All[\s\S]*<\/button>[\s\S]*id="save-btn"[\s\S]*>[\s\S]*Save & Continue/s,
  );
  assert.match(html, /id="skip-server-btn"[\s\S]*data-tooltip="You can always configure this server later\."/);
  assert.match(html, /id="skip-all-servers-btn"[\s\S]*data-tooltip="You can always configure the remaining servers later\."/);
  assert.doesNotMatch(html, /data-tooltip-follow="pointer"/);
  assert.doesNotMatch(html, /id="server-nav-container"[^>]*style=/);
  assert.match(css, /#stage-configuration\s*\{[^}]*max-width:\s*58rem;[^}]*width:\s*calc\(100% - 48px\);/s);
  assert.match(css, /#stage-configuration\.active\s*\{[^}]*padding-top:\s*0\.72rem;/s);
  assert.match(css, /#stage-configuration\.active\.is-loading\s*\{[^}]*justify-content:\s*center;[^}]*padding-top:\s*0;/s);
  assert.match(css, /#stage-configuration\s+\.configuration-stage-loading-shell\s*\{[^}]*display:\s*none;[^}]*justify-content:\s*center;/s);
  assert.match(css, /#stage-configuration\.is-loading\s+\.configuration-stage-loading-shell\s*\{[^}]*display:\s*flex;/s);
  assert.match(css, /#stage-configuration\.is-loading\s+\.configuration-stage-ready-content\s*\{[^}]*display:\s*none;/s);
  assert.match(css, /#stage-configuration\s+\.configuration-stage-subtitle\s*\{[^}]*font-size:\s*0\.92rem;[^}]*line-height:\s*1\.48;/s);
  assert.match(css, /#stage-configuration\s+\.configuration-stage-nav\s+\.oauth-stage-preview\s*\{[^}]*gap:\s*0\.5rem;[^}]*padding:\s*0\.72rem;/s);
  assert.match(css, /#stage-configuration\s+\.configuration-stage-nav\s+\.oauth-stage-preview-card\s*\{[^}]*min-width:\s*5\.75rem;[^}]*padding:\s*0\.52rem 0\.68rem;/s);
  assert.match(css, /#stage-configuration\s+\.configuration-stage-card-header\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between;/s);
  assert.match(css, /#stage-configuration\s+\.configuration-stage-card-title\s*\{[^}]*font-size:\s*0\.98rem;[^}]*color:\s*var\(--accent-text-color\);/s);
  assert.match(css, /#stage-configuration\s+\.configuration-stage-actions\s*\{[^}]*justify-content:\s*flex-end;[^}]*margin-left:\s*auto;/s);
  assert.match(css, /\[data-theme="light"\]\s+#stage-configuration\s+\.configuration-stage-actions\s+\.btn-skip\s*\{[^}]*background:\s*#d9e1ec;[^}]*color:\s*#334155;/s);
  assert.match(css, /#stage-configuration\s+\.configuration-stage-actions\s+\.btn-skip\[data-tooltip\]::after\s*\{[^}]*bottom:\s*calc\(100%\s*\+\s*8px\);[^}]*left:\s*50%;[^}]*transform:\s*translateX\(-50%\);/s);
  assert.match(css, /#stage-configuration\s+#save-btn\.is-pulsing\s*\{[^}]*animation:\s*wizard-cta-pulse 1\.8s ease-in-out infinite;/s);
  assert.match(css, /#stage-configuration\s+\.accordion-section\.is-guidance-pulsing\s*\{[^}]*animation:\s*wizard-accordion-pulse 1\.9s ease-in-out infinite;[^}]*overflow:\s*visible;[^}]*position:\s*relative;[^}]*z-index:\s*1;/s);
  assert.match(css, /#stage-configuration\s+\.accordion-section\.is-guidance-pulsing:hover,\s*#stage-configuration\s+\.accordion-section\.is-guidance-pulsing:focus-within\s*\{[^}]*animation-play-state:\s*paused;/s);
  assert.match(css, /#stage-configuration\s+\.input-field\.is-input-guidance-pulsing\s*\{[^}]*animation:\s*wizard-input-guidance-pulse 1\.8s ease-in-out infinite;[^}]*transform:\s*none;[^}]*border-color:\s*var\(--input-focus-border\);/s);
  assert.match(css, /#stage-configuration\s+\.accordion-header\s*\{[^}]*border-radius:\s*inherit;/s);
  assert.match(css, /#stage-configuration\s+\.accordion-section:not\(\.collapsed\)\s+\.accordion-header\s*\{[^}]*border-bottom-left-radius:\s*0;[^}]*border-bottom-right-radius:\s*0;/s);
  assert.match(css, /@keyframes wizard-cta-pulse\s*\{[\s\S]*?50%\s*\{[\s\S]*?transform:\s*scale\(1\.05\);[\s\S]*?box-shadow:\s*0 0 0 14px rgba\(0,\s*58,\s*155,\s*0\.24\);/s);
  assert.match(css, /@keyframes wizard-input-guidance-pulse\s*\{[\s\S]*?50%\s*\{[\s\S]*?box-shadow:\s*0 0 0 3px var\(--status-info-bg\),\s*0 0 0 10px rgba\(0,\s*58,\s*155,\s*0\.16\);/s);
  assert.match(css, /@keyframes wizard-accordion-pulse\s*\{[\s\S]*?50%\s*\{[\s\S]*?box-shadow:\s*0 0 0 10px rgba\(0,\s*58,\s*155,\s*0\.16\),\s*var\(--shadow-sm\);[\s\S]*?border-color:\s*rgba\(0,\s*58,\s*155,\s*0\.28\);/s);
  assert.match(css, /#stage-configuration\s+\.confirmation-card\s*\{[^}]*width:\s*min\(100%,\s*32rem\);[^}]*max-width:\s*32rem;[^}]*margin:\s*1rem auto 0\.7rem;[^}]*display:\s*flex;[^}]*gap:\s*0\.74rem;/s);
  assert.match(css, /#stage-configuration\s+\.confirmation-card\.is-guidance-pulsing\s*\{[^}]*animation:\s*wizard-confirmation-pulse 1\.9s ease-in-out infinite;[^}]*transform-origin:\s*center;/s);
  assert.doesNotMatch(css, /#stage-configuration\s+\.confirmation-card\.is-guidance-pulsing:hover,\s*#stage-configuration\s+\.confirmation-card\.is-guidance-pulsing:focus-within\s*\{[^}]*animation-play-state:\s*paused;/s);
  assert.match(css, /#stage-configuration\s+\.confirmation-buttons\s*\{[^}]*justify-content:\s*center;[^}]*gap:\s*0\.7rem;[^}]*margin-top:\s*0;/s);
  assert.match(css, /#stage-configuration\s+\.confirmation-buttons\s+\.btn\s*\{[^}]*min-height:\s*38px;[^}]*border-radius:\s*0\.75rem;[^}]*font-size:\s*0\.83rem;/s);
  assert.match(css, /\[data-theme="light"\]\s+#stage-configuration\s+\.btn-confirm-no\s*\{[^}]*background:\s*#d9e1ec;[^}]*color:\s*#334155;/s);
  assert.match(css, /@keyframes wizard-confirmation-pulse\s*\{[\s\S]*?50%\s*\{[\s\S]*?transform:\s*scale\(1\.02\);[\s\S]*?box-shadow:\s*0 0 0 11px rgba\(0,\s*58,\s*155,\s*0\.16\),\s*var\(--shadow-sm\);[\s\S]*?border-color:\s*rgba\(0,\s*58,\s*155,\s*0\.26\);/s);
  assert.match(progressSource, /const headerHiddenStages = \[[^\]]*'configuration'[^\]]*\];/s);
  assert.match(css, /#stage-configuration\s+\.setup-step\s*\{[^}]*font-size:\s*0\.8rem;[^}]*line-height:\s*1\.5;/s);
  assert.match(css, /\[data-theme="dark"\]\s+#stage-configuration\s+\.gs-md-cyan\s*\{[^}]*color:\s*#8fe4ff;[^}]*\}/s);
  assert.match(css, /\[data-theme="light"\]\s+#stage-configuration\s+\.gs-md-green\s*\{[^}]*color:\s*#166534;[^}]*\}/s);
  assert.match(css, /\[data-theme="light"\]\s+#stage-configuration\s+\.gs-md-red\s*\{[^}]*color:\s*#b42318;[^}]*\}/s);
  assert.match(css, /#stage-configuration\s+:is\(\.gs-md-cyan,\s*\.gs-md-green,\s*\.gs-md-yellow,\s*\.gs-md-blue,\s*\.gs-md-red\)\s+:is\(strong,\s*em,\s*a\)\s*\{[^}]*color:\s*inherit;/s);
  assert.match(parserSource, /margin-left: \$\{indentLevel \* 26\}px; margin-bottom: 6px; line-height: 1\.6;/);
  assert.match(parserSource, /<div style="margin-bottom: 6px; line-height: 1\.55;">\$1 \$2<\/div>/);
  assert.match(parserSource, /<div style="margin-left: 18px; margin-bottom: 6px; line-height: 1\.5;">• \$1<\/div>/);
  assert.match(source, /function setupPointerTrackedTooltips\(\)\s*\{/);
  assert.match(source, /document\.querySelectorAll\('\[data-tooltip-follow="pointer"\]'\)/);
  assert.match(source, /window\.handleSkipAllServers = \(\) => _handleSkipAllServers\(setupState, callbacks\);/);
  assert.match(source, /createAccordionsForVisibleContent:\s*\(container,\s*context,\s*options\)\s*=>\s*createAccordionsForVisibleContent\(container,\s*context,\s*options\)/s);
  assert.match(source, /refreshConfigurationGuidance:\s*\(\)\s*=>\s*_refreshConfigurationGuidance\(callbacks\)/);
  assert.match(source, /handleConfigurationAccordionToggle:\s*\(details\)\s*=>\s*_handleConfigurationAccordionToggle\(details,\s*callbacks\)/);
  assert.match(source, /setConfigurationLoadingState,/);
  assert.match(source, /getConfigurationScrollContainer:\s*\(\)\s*=>\s*document\.querySelector\('\.content-scroll-area'\)/);
  assert.match(screenSource, /callbacks\.setConfigurationLoadingState\?\.\(true\);/);
  assert.match(screenSource, /await callbacks\.showStage\('configuration',\s*\{\s*initialLoading:\s*true\s*\}\);/);
  assert.match(screenSource, /callbacks\.setConfigurationLoadingState\?\.\(false\);/);
  assert.match(screenSource, /callbacks\.createAccordionsForVisibleContent\(configContent,\s*'server-config',\s*\{[\s\S]*startCollapsed:\s*true,[\s\S]*onToggle:[\s\S]*scrollContainer:\s*document\.querySelector\?\.\('\.content-scroll-area'\)\s*\|\|\s*null,/s);
  assert.match(screenSource, /initializeConfigurationGuidance\(server,\s*callbacks\);/);
  assert.match(screenSource, /const CONFIGURATION_SKIP_LABEL = 'Skip';/);
  assert.match(screenSource, /const CONFIGURATION_SKIP_ALL_LABEL = 'Skip All';/);
  assert.match(screenSource, /const CONFIGURATION_INPUT_PULSE_CLASS = 'is-input-guidance-pulsing';/);
  assert.match(screenSource, /const\s*\{\s*createConfigurationGuidanceController,\s*evaluateConfigurationReadiness,\s*resolveConfigurationPulseTarget,\s*\}\s*=\s*require\('\.\.\/\.\.\/components\/configuration-guidance'\);/s);
  assert.match(screenSource, /function getVisibleConfirmationCard\(/);
  assert.match(screenSource, /function focusConfigurationAccordionInput\(accordion,\s*doc = globalThis\.document\) \{/);
  assert.match(screenSource, /event\.target\.classList\?\.remove\?\.\(CONFIGURATION_INPUT_PULSE_CLASS\);/);
  assert.match(screenSource, /focusedInputId:\s*focusedInput\?\.id \|\| null,/);
  assert.match(accordionSource, /scheduleExpandedAccordionVisibility\(accordion,\s*\{/);
  assert.match(screenSource, /function handleConfigurationAccordionToggle\(/);
  assert.match(screenSource, /querySelectorAll\('\.confirmation-card'\)/);
  assert.match(screenSource, /querySelectorAll\(`\.confirmation-card\.\$\{CONFIGURATION_CONFIRMATION_PULSE_CLASS\}`\)/);
  assert.match(screenSource, /if \(pulseTarget === 'confirmation' && confirmationId\) \{/);
  assert.match(accordionSource, /function createAccordionsForVisibleContent\(container,\s*context,\s*options = \{\}\)/);
  assert.match(accordionSource, /const startCollapsed = options\.startCollapsed === true;/);
  assert.match(accordionSource, /const autoExpandFirst = options\.autoExpandFirst === true;/);
  assert.match(accordionSource, /header\.onclick = \(\) => \{[\s\S]*const isCollapsed = toggleAccordion\(accordionId\);[\s\S]*onToggle\(/s);
  assert.match(accordionSource, /if \(autoExpandFirst && startCollapsed && createdAccordions\.length > 0\) \{[\s\S]*const firstAccordion = createdAccordions\[0\];[\s\S]*firstAccordion\.header\.onclick\(\);/s);
  assert.match(parserSource, /<div class="confirmation-card" id="\$\{confirmationId\}" data-guidance-target="confirmation">/);
  assert.match(parserSource, /class="confirmation-button-icon" aria-hidden="true">✓<\/span>[\s\S]*<span>Yes<\/span>/s);
  assert.match(confirmationSource, /function getConfirmationFollowUpAccordionOptions\(context,\s*callbacks = \{\}\) \{[\s\S]*startCollapsed:\s*true,[\s\S]*autoExpandFirst:\s*true,[\s\S]*onToggle:\s*callbacks\.handleConfigurationAccordionToggle,[\s\S]*scrollContainer:\s*callbacks\.getConfigurationScrollContainer\?\.\(\),/s);
  assert.match(confirmationSource, /if \(createdAccordions\.length === 0\) \{[\s\S]*watchDeferredConfirmationFollowUp\(afterContent,\s*confirmationId,\s*context,\s*callbacks\);/s);
  assert.match(confirmationSource, /callbacks\.refreshConfigurationGuidance\(\);/);
});

test("guided setup resolves progress and browser visibility against the active stage after reroutes", () => {
  const source = readRepoFile("electron-app/src/renderer/views/guided-setup.js");
  const progressSource = readRepoFile("electron-app/src/renderer/components/setup-progress.js");
  const css = readRepoFile("electron-app/src/renderer/views/guided-setup.css");

  assert.match(source, /const activeStage = setupState\.currentStage \|\| resolvedStage;/);
  assert.match(source, /function getProgressTrackerState\(\) \{\s*return \{\s*oauthServers:\s*setupState\.oauthServers,[\s\S]*connectedOAuthServers:\s*setupState\.connectedOAuthServers,[\s\S]*configuredServers:\s*setupState\.configuredServers,[\s\S]*skippedServers:\s*setupState\.skippedServers,/s);
  assert.match(source, /toggleProgressVisibility\(\s*activeStage,\s*setupState\.completedSteps,\s*setupState\.onboardingMode,\s*setupState\.prereqPolicy,/s);
  assert.match(source, /showPrerequisitesTracker:\s*setupState\.prerequisitesManualVisit/);
  assert.match(source, /loadBrowserContent\(activeStage\);/);
  assert.match(source, /updateProgressTracker\(\s*activeStage,\s*setupState\.completedSteps,\s*setupState\.serverConfigs,\s*setupState\.onboardingMode,\s*setupState\.prereqPolicy,\s*setupState\.oauthStepRequired,\s*getProgressTrackerState\(\)\s*\)/s);
  assert.match(progressSource, /step\.classList\.remove\('active',\s*'completed',\s*'inactive',\s*'warning',\s*'partial'\);/);
  assert.match(progressSource, /const oauthProgress = getOauthProgress\(completedSteps,\s*progressState\);/);
  assert.match(progressSource, /const configurationProgress = getConfigurationProgress\(currentStage,\s*completedSteps,\s*serverConfigs,\s*progressState\);/);
  assert.match(progressSource, /function oauthStepIsHidden\(oauthStepRequired,\s*progressState = \{\}\) \{/);
  assert.match(progressSource, /const oauthServerIds = toTrackedIdSet\(progressState\.oauthServers\);/);
  assert.match(progressSource, /else if \(oauthProgress\.isPartial\) \{\s*step\.classList\.add\('partial'\);/s);
  assert.match(progressSource, /else if \(configurationProgress\.isPartial\) \{\s*step\.classList\.add\('partial'\);/s);
  assert.match(css, /\.progress-step\.partial \.progress-circle::after\s*\{[^}]*content:\s*'✓';[^}]*background:\s*var\(--status-warning\);/s);
});

test("guided setup manual prereq revisits suppress the prerequisites screen auto-advance", () => {
  const viewSource = readRepoFile("electron-app/src/renderer/views/guided-setup.js");
  const prereqSource = readRepoFile(
    "electron-app/src/renderer/screens/guided-setup/screen-prerequisites.js",
  );
  const progressSource = readRepoFile("electron-app/src/renderer/components/setup-progress.js");

  assert.match(viewSource, /setupState\.prerequisitesManualVisit =\s*resolvedStage === 'prerequisites' && options\.manualVisit === true;/);
  assert.match(viewSource, /manualVisit:\s*setupState\.prerequisitesManualVisit,/);
  assert.match(viewSource, /suppressAutoAdvance:\s*options\.suppressPrereqAutoAdvance === true,/);
  assert.match(viewSource, /showStage\('prerequisites',\s*\{\s*suppressPrereqAutoAdvance:\s*true,\s*manualVisit:\s*true\s*\}\);/);
  assert.match(progressSource, /const showPrerequisitesTracker = stageName === 'prerequisites' && options\.showPrerequisitesTracker === true;/);
  assert.match(progressSource, /if \(showPrerequisitesTracker \|\| !trackerHiddenStages\.includes\(stageName\)\)/);
  assert.match(prereqSource, /const PREREQ_STAGE_TRANSITION_DELAY_MS = 1000;/);
  assert.match(prereqSource, /const PREREQ_FINAL_AUTO_ADVANCE_DELAY_MS = 2000;/);
  assert.match(prereqSource, /suppressAutoAdvance:\s*false/);
  assert.match(prereqSource, /manualVisit:\s*false/);
  assert.match(prereqSource, /state\.manualVisit = options\.manualVisit === true;/);
  assert.match(prereqSource, /state\.suppressAutoAdvance = options\.suppressAutoAdvance === true;/);
  assert.match(prereqSource, /await waitForPrereqUiDelay\(PREREQ_STAGE_TRANSITION_DELAY_MS\);/);
  assert.match(prereqSource, /if \(state\.suppressAutoAdvance\) \{/);
  assert.match(prereqSource, /syncContinueStateForReadyPrerequisites\(\);/);
  assert.match(prereqSource, /setTimeout\(\(\) => \{[\s\S]*PREREQ_FINAL_AUTO_ADVANCE_DELAY_MS\);/s);
  assert.match(prereqSource, /helper: state\.authorizeReadiness\.ready\s*\?\s*\(state\.manualVisit \? '' : 'Core runtime containers are ready\. Moving you along now\.'\)/s);
  assert.match(prereqSource, /panel\.classList\.add\('is-compact'\);/);
  assert.doesNotMatch(prereqSource, /docker-hull/);
});

test("guided setup debug drawer shadow only appears while the drawer is open", () => {
  const css = readRepoFile("electron-app/src/renderer/views/guided-setup.css");

  assert.match(css, /\.guided-setup-debug-drawer\s*\{[^}]*box-shadow:\s*none;/s);
  assert.match(css, /\.guided-setup-debug-drawer\.open\s*\{[^}]*box-shadow:\s*-24px 0 48px rgba\(15,\s*23,\s*42,\s*0\.18\);/s);
});

test("guided setup derives prereq policy from bootstrap launch context instead of a flat skip flag", () => {
  const source = readRepoFile("electron-app/src/renderer/views/guided-setup.js");

  assert.match(source, /window\.electronAPI\?\.getGuidedSetupBootstrapState/);
  assert.match(source, /getGuidedSetupLaunchSource\(\) === 'required'/);
  assert.match(source, /reason:\s*'manual-ready'/);
  assert.match(source, /if \(!prereqPolicy\.showStep\) \{\s*await advanceAfterPrerequisites\(\);/s);
  assert.match(source, /if \(prereqPolicy\.noInteractiveWorkRequired\) \{\s*await _bootstrapPrerequisitesSession\(\{ shouldResume: false \}\);/s);
});

test("guided setup OAuth success auto-advances to the next pending server", () => {
  const source = readRepoFile("electron-app/src/renderer/screens/guided-setup/screen-oauth.js");

  assert.match(source, /function shouldAutoAdvanceAfterSuccess\(\)/);
  assert.match(source, /if \(shouldAutoAdvanceAfterSuccess\(\)\) \{\s*advanceToNextPendingServer\(\);/s);
  assert.match(
    source,
    /async function markCurrentAsDoneNoRestart[\s\S]*?if \(areAllServersProcessed\(\)\) \{\s*handleOAuthComplete\(setupState, callbacks\);[\s\S]*?updatePreviewBar\(\);/s,
  );
});

test("guided setup skips OAuth readiness when every selected integration is already authorized", () => {
  const oauthSource = readRepoFile("electron-app/src/renderer/screens/guided-setup/screen-oauth.js");
  const serverSelectionSource = readRepoFile("electron-app/src/renderer/screens/guided-setup/screen-server-selection.js");
  const progressSource = readRepoFile("electron-app/src/renderer/components/setup-progress.js");

  assert.match(oauthSource, /async function analyzeOAuthServers\(oauthServers = \[\]\)/);
  assert.match(
    oauthSource,
    /const analysis = await analyzeOAuthServers\(setupState\.oauthServers \|\| \[\]\);[\s\S]*setupState\.oauthStepRequired = analysis\.pendingCount > 0;[\s\S]*if \(analysis\.pendingCount === 0\) \{[\s\S]*await proceedAfterOAuth\(setupState, callbacks\);/s,
  );
  assert.match(serverSelectionSource, /if \(oauthServers\.length > 0 && callbacks\.analyzeOAuthServers\) \{/);
  assert.match(serverSelectionSource, /setupState\.oauthStepRequired = oauthAnalysis\.pendingCount > 0;/);
  assert.match(progressSource, /stepName === 'oauth' && oauthStepIsHidden\(oauthStepRequired,\s*progressState\)/);
});

test("guided setup connect skip actions reuse Configure button copy and block premature Configure navigation", () => {
  const css = readRepoFile("electron-app/src/renderer/views/guided-setup.css");
  const oauthSource = readRepoFile("electron-app/src/renderer/screens/guided-setup/screen-oauth.js");
  const viewSource = readRepoFile("electron-app/src/renderer/views/guided-setup.js");
  const progressSource = readRepoFile("electron-app/src/renderer/components/setup-progress.js");

  assert.match(oauthSource, /id="oauth-stage-next-btn"[\s\S]*data-tooltip="You can always connect more integrations later\."[\s\S]*>Skip<\/button>/s);
  assert.match(oauthSource, /id="oauth-stage-skip-all-btn"[\s\S]*data-tooltip="You can always connect more integrations later\."[\s\S]*>Skip All<\/button>/s);
  assert.match(oauthSource, /nextBtn\.textContent = 'Skip';/);
  assert.match(oauthSource, /skipAllBtn\.textContent = 'Skip All';/);
  assert.match(oauthSource, /id="oauth-test-skip-btn"[\s\S]*data-tooltip="You can always connect more integrations later\."[\s\S]*>Skip<\/button>/s);
  assert.match(oauthSource, /id="oauth-test-skip-all-btn"[\s\S]*data-tooltip="You can always connect more integrations later\."[\s\S]*>Skip All<\/button>/s);
  assert.match(css, /\[data-theme="light"\]\s+\.oauth-stage-preview-icon\[data-logo-kind="portico"\]\s*\{[^}]*background:\s*#153f90;[^}]*filter:\s*none;/s);
  assert.match(css, /\[data-theme="light"\]\s+#stage-oauth\s+\.oauth-stage-server-icon\[data-logo-kind="portico"\]\s*\{[^}]*padding:\s*10px;[^}]*background:\s*#153f90;[^}]*filter:\s*none;/s);
  assert.doesNotMatch(css, /\[data-theme="light"\]\s+\.oauth-stage-server-icon\[data-logo-kind="portico"\]\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;/s);
  assert.match(css, /#stage-oauth\s+\.oauth-stage-nav-buttons\s+\.oauth-skip-btn,\s*#stage-oauth\s+\.oauth-test-success-actions\s+\.oauth-test-skip-btn\s*\{[^}]*min-height:\s*38px;[^}]*border-radius:\s*0\.7rem;/s);
  assert.match(css, /#stage-oauth\s+\.oauth-skip-btn\[data-tooltip\]::after,\s*#stage-oauth\s+\.oauth-test-skip-btn\[data-tooltip\]::after\s*\{[^}]*bottom:\s*calc\(100%\s*\+\s*8px\);[^}]*left:\s*50%;[^}]*transform:\s*translateX\(-50%\);/s);
  assert.match(css, /\[data-theme="light"\]\s+#stage-oauth\s+\.oauth-skip-btn,\s*\[data-theme="light"\]\s+#stage-oauth\s+\.oauth-test-skip-btn\s*\{[^}]*background:\s*#d9e1ec;[^}]*color:\s*#334155;/s);
  assert.match(viewSource, /function canNavigateToConfigurationStep\(\) \{/);
  assert.match(viewSource, /const oauthStepIncluded = Array\.isArray\(setupState\.oauthServers\) && setupState\.oauthServers\.length > 0;/);
  assert.match(viewSource, /return setupState\.currentStage === 'configuration' \|\|[\s\S]*setupState\.completedSteps\.oauth === true \|\|[\s\S]*!oauthStepIncluded;/s);
  assert.match(viewSource, /stepName === 'configuration' && canNavigateToConfigurationStep\(\)/);
  assert.match(progressSource, /const canAccessConfiguration = serverConfigs\.length > 0 && \([\s\S]*completedSteps\.oauth[\s\S]*oauthStepIsHidden\(oauthStepRequired,\s*progressState\)[\s\S]*currentStage === 'configuration'[\s\S]*\);/s);
  assert.match(viewSource, /showStage\('oauth',\s*\{\s*suppressOauthAutoAdvance:\s*true\s*\}\);/);
  assert.match(viewSource, /await _loadOAuthScreen\(setupState,\s*callbacks,\s*\{\s*suppressAutoAdvance:\s*options\.suppressOauthAutoAdvance === true,\s*autoStartPending:\s*options\.autoStartPendingOAuth === true,\s*\}\);/s);
  assert.match(oauthSource, /function renderCompletedOauthRevisitScreen\(setupState,\s*callbacks = \{\},\s*analysis = \{\}\)/);
  assert.match(oauthSource, /function resolveCompletedOauthCurrentIndex\(setupState\)/);
  assert.match(oauthSource, /if \(options\.suppressAutoAdvance === true\) \{\s*renderCompletedOauthRevisitScreen\(setupState,\s*callbacks,\s*analysis\);\s*return;\s*\}/s);
  assert.match(oauthSource, /showContinue \? 'Continue →' : 'Next →'/);
  assert.match(oauthSource, /setupState\.skippedOAuthServers\.delete\(serverId\);/);
});

test("guided setup finalize card stays rounded and guided setup window resize animations are deduped", () => {
  const css = readRepoFile("electron-app/src/renderer/views/guided-setup.css");
  const mainSource = readRepoFile("electron-app/src/services/main.js");

  assert.match(css, /#stage-finalize \.setup-step\s*\{[^}]*border-radius:\s*1rem;[^}]*\}/s);
  assert.match(mainSource, /const guidedSetupWindowAnimationState = \{\s*token:\s*0,\s*timer:\s*null,\s*targetKey:\s*null,\s*\};/s);
  assert.match(mainSource, /if \(\s*guidedSetupWindowAnimationState\.targetKey === targetKey &&\s*guidedSetupWindowAnimationState\.timer\s*\) \{/s);
  assert.match(mainSource, /clearTimeout\(guidedSetupWindowAnimationState\.timer\);/);
});

test("guided setup welcome CTA reuses the same pulse treatment as the success launch CTA", () => {
  const css = readRepoFile("electron-app/src/renderer/views/guided-setup.css");

  assert.match(
    css,
    /#oauth-stage-authorize-btn,\s*#welcome-start-button,\s*#success-launch-btn,\s*\.prerequisites-continue\s+#prerequisites-continue-btn,\s*\.oauth-test-next-btn\s*\{[^}]*animation:\s*wizard-cta-pulse 1\.8s ease-in-out infinite;[^}]*transform-origin:\s*center;[^}]*\}/s,
  );
  assert.match(
    css,
    /#oauth-stage-authorize-btn:hover,\s*#oauth-stage-authorize-btn:focus-visible,\s*#welcome-start-button:hover,\s*#welcome-start-button:focus-visible,\s*#success-launch-btn:hover,\s*#success-launch-btn:focus-visible,\s*\.prerequisites-continue\s+#prerequisites-continue-btn:hover,\s*\.prerequisites-continue\s+#prerequisites-continue-btn:focus-visible,\s*\.oauth-test-next-btn:hover,\s*\.oauth-test-next-btn:focus-visible\s*\{[^}]*animation-play-state:\s*paused;[^}]*\}/s,
  );
  assert.match(
    css,
    /#oauth-stage-authorize-btn:disabled,\s*#welcome-start-button:disabled,\s*#success-launch-btn:disabled,\s*\.prerequisites-continue\s+#prerequisites-continue-btn:disabled,\s*\.oauth-test-next-btn:disabled\s*\{[^}]*animation:\s*none;[^}]*\}/s,
  );
});

// PORTICO-376: a required update must not preempt first-run setup. The launch
// update gate consults the setup decision and, on a fresh / not-set-up install,
// runs guided setup first (deferring the update) instead of dead-ending at
// "Required update preparation failed".
test("required update defers to guided setup on not-set-up installs (PORTICO-376)", () => {
  const windowsSource = readRepoFile("electron-app/src/services/windows.js");
  assert.match(windowsSource, /shouldDeferRequiredUpdateForSetup\(setupDecision\)/);
  assert.match(windowsSource, /source: 'update-deferred-for-setup', updateDeferred: true/);
});
