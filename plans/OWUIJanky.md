# OWUI Jank Fix Plan (Replace <webview> With BrowserView)

## Goal
Eliminate resize jank by removing Electron `<webview>` usage for Open WebUI (OWUI) and replacing it with `BrowserView`-backed renderers while preserving all existing hooks, patches, and behaviors.

## Scope
Applies to OWUI rendering in:
- Main chat tab (control panel window).
- Conversation tabs (subagent tabs) within the main window.
- Detached chat window (main chat detached or "New Chat Window").
- Detached conversation window (standalone OWUI window with warning banner).

Not in scope for this change:
- Artifact preview webviews (`persist:artifacts`).
- Guided setup webview.
- Debugger webviews (MCPO).

## Root Cause Summary
OWUI is currently embedded via `<webview>` guest views. Electron guest views have a slower compositor path during live resizing compared to top-level renderers, causing jank. Removing `<webview>` and using `BrowserView` (or direct `BrowserWindow.loadURL`) avoids the guest-view pipeline.

## Current Integration Map (Must Preserve)
These are the critical OWUI hooks/injections that must continue to function:

1) Artifact actions from OWUI to host
- OWUI uses `window.webviewHost.sendArtifactAction` (exposed by `electron-app/src/services/chat-webview-preload.js`).
- Host listens via webview `ipc-message` in `electron-app/src/renderer/components/artifact-indicator.js`.
- The component that calls `webviewHost` is `src/patches/frontend/src/lib/components/chat/ActiveCapabilities.svelte`.

2) Artifact updates from host to OWUI
- Host calls `webview.executeJavaScript` to trigger:
  - `window.__updateArtifacts` and
  - `window.dispatchEvent(new CustomEvent('artifacts-updated'))`
  - See `electron-app/src/renderer/components/artifact-indicator.js`.
- OWUI listens in `src/patches/frontend/src/lib/components/chat/MessageInput.svelte`.

3) Theme sync and CSS injection
- Theme sync via `webview.executeJavaScript` in:
  - `electron-app/src/renderer/theme.js`
  - `electron-app/src/renderer/components/chat-tab.js`
  - `electron-app/src/renderer/views/conversation-window.js`
- Cursor/textarea fix CSS injected with `webview.insertCSS` in:
  - `electron-app/src/renderer/components/chat-tab.js`
  - `electron-app/src/renderer/views/conversation-window.js`

4) Navigation and link handling
- `setup-webview-link-handler` (main process) sets:
  - `setWindowOpenHandler` to route OWUI conversation links into main window tabs.
  - `will-navigate` allowlist for OWUI + workspace downloads.
  - See `electron-app/src/services/main.js`.

5) Load/reconnect logic
- Renderer uses webview events (`did-fail-load`, `did-finish-load`) and a JS health check to drive reconnect overlays in `electron-app/src/renderer/components/chat-tab.js`.

6) URL tracking for chat changes
- `artifact-indicator.js` uses `webview.getURL()` and navigation events to detect chat changes.

7) Detached chat window (windowType=chat)
- Rendered via `electron-app/src/renderer/views/conversation-window.js` today.
- Uses the same link handling + theme/CSS injection path as detached subagent windows.

## Target Architecture
Replace OWUI webviews with `BrowserView` instances managed by main process.

Key components:
- OwuiViewManager (new module in main process)
  - Creates/destroys BrowserViews per window/tab.
  - Tracks mapping: { windowId, viewKey, type, windowType, conversationId, url }.
  - Applies navigation guards (window open handler, allowlist).
  - Forwards load, navigation, and console events to renderer.
  - Standardize viewKey naming: `main`, `conversation:<id>`, `detached-chat:<id>`, `detached-subagent:<id>`.
- OWUI Preload (new or updated preload)
  - Exposes `window.webviewHost.sendArtifactAction`.
  - Receives artifact updates via IPC and dispatches the same events used today.
  - Optionally receives theme/CSS updates via IPC to avoid `executeJavaScript` in main.

## Migration Plan (Concrete Steps)

### Phase 0: Safety and Feature Flag
1) Introduce a feature flag to toggle the new path:
   - Example env: `PORTICO_OWUI_BROWSER_VIEW=1`.
2) Keep existing `<webview>` path as fallback until validation is complete.

### Phase 1: Main Process OWUI View Manager
Create a new module (example path: `electron-app/src/services/owui-views.js`) with:
1) `createOwuiView({ windowId, viewKey, url, partition, preloadPath, windowType })`
   - Partition must match `persist:openwebui`.
   - `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `preload: owui-preload.js`.
   - Use stable viewKey names: `main`, `conversation:<id>`, `detached-chat:<id>`, `detached-subagent:<id>`.
2) `attachOwuiView(window, viewKey, bounds)`
   - Uses `BrowserWindow.addBrowserView`.
   - Sets bounds based on renderer-provided `getBoundingClientRect`.
3) `detachOwuiView(window, viewKey)` and `destroyOwuiView(viewKey)`.
4) `setOwuiBounds(window, viewKey, bounds)`
   - Called on resize, divider drag, and tab switch.
5) Apply navigation guards (port allowlist + conversation link routing):
   - Implement `applyOwuiNavigationGuards(webContents, { ownerWindowId })` by lifting logic from `setup-webview-link-handler` in `electron-app/src/services/main.js`.
6) Forward critical webContents events to renderer via IPC:
   - `did-finish-load`, `did-fail-load`, `did-navigate`, `did-navigate-in-page`,
     `dom-ready`, `console-message`, `render-process-gone`.
7) On `dom-ready`:
   - Inject cursor-fix CSS (same as current `insertCSS` strings).
   - Trigger theme sync (see Phase 3).
   - (Optional) run the current OWUI health-check JS once to ensure parity.

### Phase 2: OWUI Preload Bridge
Create/update preload script (example: `electron-app/src/services/owui-preload.js`):
1) Replace `ipcRenderer.sendToHost` with `ipcRenderer.send`:
   - `window.webviewHost.sendArtifactAction(action, artifactId)` should send to main on a new channel `owui-artifact-action`.
2) Listen for artifact update messages:
   - `ipcRenderer.on('owui-artifacts-update', (event, detail) => {`
     - Call `window.__updateArtifacts(detail)` if defined.
     - Dispatch `new CustomEvent('artifacts-updated', { detail })`.
   - This preserves behavior from `MessageInput.svelte`.
3) Theme and CSS injection (choose one):
   - Option A (preferred): `ipcRenderer.on('owui-set-theme', ...)` and `ipcRenderer.on('owui-insert-css', ...)` apply changes inside OWUI.
   - Option B: Main executes `webContents.executeJavaScript` / `insertCSS` directly.

### Phase 3: Renderer API and IPC Wiring
Update file: `electron-app/src/services/preload.js`
Expose new OWUI APIs to renderer:
- `owuiCreateView(viewKey, url, windowType, conversationId)`
- `owuiDestroyView(viewKey)`
- `owuiShowView(viewKey)`
- `owuiSetBounds(viewKey, bounds)`
- `owuiReload(viewKey)`
- `owuiSendArtifactsUpdate(viewKey, detail)`
- `owuiSetTheme(viewKey, themeName)`
- `onOwuiLoadState(callback)`
- `onOwuiConsoleMessage(callback)`
- `onOwuiArtifactAction(callback)`
- `onOwuiNavigation(callback)`

Main process handles these IPC channels by delegating to OwuiViewManager.

### Phase 4: Main Chat Tab Migration
Update file: `electron-app/src/renderer/views/index.html`
- Remove `<webview id="chat-webview">`.
- Keep `#chat-container` as the layout host for bounds calculation.

Update file: `electron-app/src/renderer/components/chat-tab.js`
1) Replace webview creation/management with IPC:
   - On load: `owuiCreateView('main', 'http://localhost:3789', 'main')`.
2) Bounds handling:
   - Use `ResizeObserver` on `#chat-container`.
   - Send bounds to main via `owuiSetBounds('main', bounds)`.
   - Also call on window resize and artifact divider drag events.
3) Replace load/reconnect logic:
   - Subscribe to `onOwuiLoadState` from main.
   - When showing reconnect overlay, hide/detach BrowserView or show overlay in OWUI itself:
     - Option A: temporarily `owuiShowView(false)` so DOM overlay is visible.
     - Option B: inject overlay HTML/CSS into OWUI via preload.
4) Replace `webview.executeJavaScript` health check with a main-side execution or preload-driven check.
5) Remove `setupWebviewLinkHandler` calls and rely on main navigation guards.
6) Detach main chat tab:
   - When `detachMainChatTab` spawns a chat window (`windowType=chat`), create a BrowserView in that window and keep the main view reset to `http://localhost:3789`.
   - Ensure theme/artifact sync works in both windows after detach.

### Phase 5: Artifact Indicator Migration
Update file: `electron-app/src/renderer/components/artifact-indicator.js`
1) Replace webview `ipc-message` listener:
   - Listen to `window.electronAPI.onOwuiArtifactAction`.
2) Replace `webview.executeJavaScript` updates:
   - Call `window.electronAPI.owuiSendArtifactsUpdate('main', detail)` to trigger preload dispatch inside OWUI.
3) Replace `webview.getURL()`:
   - Use `window.electronAPI.owuiGetUrl('main')` or listen to `onOwuiNavigation` events forwarded from main.

### Phase 6: Theme Sync Migration
Update file: `electron-app/src/renderer/theme.js`
1) Replace `syncThemeToWebview` and `syncThemeToAllWebviews`:
   - Call `window.electronAPI.owuiSetTheme(viewKey, themeName)` for main + conversation views.
2) Ensure the same theme script content is used so OWUI localStorage/theme classes remain identical.

### Phase 7: Conversation Tabs (Main Window)
Update file: `electron-app/src/renderer/components/chat-tab.js`
1) When opening a conversation tab:
   - Call `owuiCreateView('conversation:<id>', url, 'conversation', conversationId)`.
2) When switching tabs:
   - Call `owuiShowView` for the active tab and hide others.
3) Bounds:
   - Use the tab-specific `chat-container` element to set bounds.
4) Preserve warning banner behavior (DOM) while BrowserView fills only the chat container bounds.

### Phase 8: Detached Windows (Conversation + Chat)
Update file: `electron-app/src/renderer/views/conversation-window.html`
- Remove `<webview>` element.
- Keep warning banner + `chat-container` for layout.
- If `windowType=chat`, decide whether to keep or hide the warning banner and wire it via query params.

Update file: `electron-app/src/renderer/views/conversation-window.js`
1) Read `windowType` from query params (`chat` vs `subagent`) and set a viewKey:
   - `detached-chat:<conversationId>` for chat windows.
   - `detached-subagent:<conversationId>` for subagent windows.
2) On load, call `owuiCreateView(viewKey, url, windowType, conversationId)`.
3) Use `ResizeObserver` to send bounds of the local chat container to main.
4) Replace `setupWebviewLinkHandler` usage with main navigation guards.
5) Theme sync via `owuiSetTheme`.
6) Ensure conversation links opened from a detached chat window still route to the main window when present.

Update file: `electron-app/src/services/windows.js`
- Pass `windowType` through to `conversation-window.html` query params.

### Phase 9: Navigation Guards and Conversation Links
Update file: `electron-app/src/services/main.js`
1) Deprecate `setup-webview-link-handler` for OWUI views.
2) When OwuiViewManager creates a view, apply:
   - `setWindowOpenHandler` logic from `setup-webview-link-handler`.
   - `will-navigate` allowlist (localhost:3789 + workspace downloads).
3) Preserve behavior where conversation links open in the main window tabs:
   - Always send `open-conversation-tab` to `state.windows.main` when available.
   - Fall back to the owner window for detached chat when the main window is missing.

### Phase 10: Automation and Tooling Updates
Update file: `electron-app/mcp-server/index.js`
- Current automation looks for OWUI webviews by URL.
- With BrowserView, update detection to inspect BrowserView `webContents.getURL()` or maintain an OwuiViewManager registry.
- Update `electron_wait_ready` / `electron_list_webviews` accordingly.

### Phase 11: Validation Plan (Manual)
1) Main chat window:
   - Resize test (jank reduction).
   - Load OWUI; verify reconnect overlay behavior.
   - Open external links; ensure external browser opens.
2) Conversation tab:
   - Open from OWUI link; ensure tab creation works.
   - Switch tabs; confirm BrowserView swaps cleanly.
3) Detached window:
   - Detach main chat; verify OWUI loads and resizes smoothly, and main resets to home.
   - Open "New Chat Window" from menu; verify load/resizing and theme.
   - Detach subagent conversation; verify banner behavior and resizing.
4) Artifacts:
   - Artifact list appears in OWUI (MessageInput).
   - Artifact actions (open/detach/attach) work from OWUI.
5) Theme:
   - Toggle light/dark; confirm OWUI theme matches.
6) Navigation restrictions:
   - Attempt to navigate to non-allowed URL; ensure external open.

### Phase 12: Rollout
1) Default feature flag to off.
2) Enable in dev builds; collect feedback.
3) Flip default once stable; remove old webview path later.

## Key Risk Areas and Mitigations
- Overlays hidden by BrowserView: BrowserView renders above DOM, so reconnect overlays must either hide the view or be injected into OWUI.
- Artifact action bridging: Must move from `sendToHost` + `ipc-message` to IPC channels while preserving `window.webviewHost`.
- Theme sync timing: Ensure theme injection happens after OWUI `dom-ready`.
- Navigation guard parity: Must replicate `setup-webview-link-handler` behavior exactly to avoid regressions in conversation tab routing.
- Detached chat routing: Ensure conversation links from detached chat still open in main window when present.
- Automation breakage: Test harness assumes OWUI is a webview; update accordingly.

## File Touch List (Expected)
Main process:
- `electron-app/src/services/main.js`
- `electron-app/src/services/ipc.js` (new IPC handlers)
- `electron-app/src/services/windows.js` (optional: window config tweaks)
- `electron-app/src/services/owui-views.js` (new)
- `electron-app/src/services/owui-preload.js` (new or update `chat-webview-preload.js`)

Renderer:
- `electron-app/src/renderer/views/index.html`
- `electron-app/src/renderer/views/conversation-window.html`
- `electron-app/src/renderer/views/conversation-window.js`
- `electron-app/src/renderer/components/chat-tab.js`
- `electron-app/src/renderer/components/artifact-indicator.js`
- `electron-app/src/renderer/theme.js`
- `electron-app/src/services/preload.js`

OWUI patches (no changes expected if bridge preserved):
- `src/patches/frontend/src/lib/components/chat/ActiveCapabilities.svelte`
- `src/patches/frontend/src/lib/components/chat/MessageInput.svelte`

Automation:
- `electron-app/mcp-server/index.js`

## Success Criteria
- Resizing the main chat window, detached chat window, and detached conversation window is smooth and comparable to Chrome.
- All OWUI integrations (artifact actions, artifact updates, theme sync, navigation routing) work as before.
- No regressions in conversation tab behavior or external link handling.
