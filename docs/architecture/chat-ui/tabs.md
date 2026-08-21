# Tab Architecture -- Technical Design

## Overview

The tab system converts the multi-window chat model into a single-window, browser-style tab bar. Each tab maps to an OWUI `WebContentsView` managed by the main process. The architecture spans three layers:

- **Electron Shell**: Tab bar UI component, state management, keyboard shortcuts
- **IPC/Communication**: Active view tracking, tab lifecycle events, cross-tab navigation
- **State & Persistence**: Tab order and metadata persisted to localStorage

## Requirements

### Functional

- FR-1: Dynamic conversation tabs can detach into standalone windows from either the tab context menu or a drag-out gesture from the main header strip
- FR-2: Drag-out detach must feel immediate on pointer release after the tab leaves the shell drop zone; users should not have to wait on a long hold delay before the detached window appears
- FR-3: Detached conversations can return to the main shell only through the explicit compact Return to Tab action in the detached header; moving a detached window over the main tab strip never redocks it
- FR-4: Detach and reattach flows must reuse the same conversation view identity (`viewKey`) so live OWUI session state, in-flight activity, and local conversation context stay attached to the moved surface instead of opening a duplicate
- FR-5: Tab titles must stay synchronized across attached and detached presentations; custom titles remain authoritative, and the detached window header shows the active conversation title
- FR-6: The detached window header must keep the conversation title centered and expose a small return affordance without adding a second toolbar row above the chat content
- FR-7: Inline tab rename must suppress OWUI refocus while the editor is active so keyboard input stays in the rename field until commit or cancel
- FR-8: Shell-driven navigation such as cross-conversation search must activate an already-open conversation tab before message reveal instead of spawning redundant tabs
- FR-9: Keyboard behavior remains window-aware: main-window tab shortcuts continue to target the tab strip, while detached windows keep normal close-window semantics and can be reattached without conflicting shortcut handling
- FR-10: The permanent shell tab (`chat`) stays non-detachable; only dynamic conversation tabs participate in tear-off and reattach flows. Control Plane is not a tab and is opened from a header toggle button.

### Non-Functional

- NFR-1: Detach and reattach must avoid redundant page reloads when the underlying conversation URL is equivalent and only shell-specific parameters differ
- NFR-2: Window-transfer behavior must remain event-driven and avoid new polling loops, recurring timers, or broad IPC broadcasts on hot paths
- NFR-3: Detached-window chrome must preserve the existing chat viewport proportions by reusing the titlebar safe area instead of introducing a dedicated toolbar row
- NFR-4: Detached title styling must match the active attached-tab treatment for typography, color, and truncation behavior so the same conversation reads consistently in both surfaces
- NFR-5: Cross-feature navigation after a tab switch must reveal the target message with top clearance so sticky headers and masks do not leave the message partially obscured
- NFR-6: Tab order, title metadata, and active-view bookkeeping remain durable across restart and across attach/detach transitions
- NFR-7: Focus and attached-tab drag/drop feedback must stay responsive under macOS hidden-titlebar constraints without stealing the user's text cursor from active rename input

## Tab Model

### Permanent Tabs

| ID | Title | Notes |
|---|---|---|
| `chat` | Chat | OWUI home / new chat landing; always first in the tab strip |

The `chat` tab is the only permanent tab in the strip (`PERMANENT_TABS = new Set(['chat'])` in `tab-bar.js`). It cannot be closed, detached, or reordered, but it is renameable and persists its custom title.

`control` exists in `state.tabOrder`/`state.tabMeta` for bookkeeping, but it is **not** rendered in the tab strip. The visible tab order filters it out (`getVisibleTabOrder()` returns `tabOrder.filter(id => id !== 'control')`). Control Plane is opened from a dedicated `#control-plane-toggle` button in the header right-side controls; its content lives in the `#control-tab` panel.

### Dynamic Tabs

Dynamic tabs represent individual conversations. Each has:

- **tabId**: Conversation ID or a generated ID (e.g., `chat-1710072000-a3f2b1`)
- **fullTabId**: `conversation-{tabId}` (used in DOM and IPC)
- **viewKey**: `conversation:{tabId}` (OWUI view identifier in main process)

Dynamic tabs can be closed, reordered via drag, renamed, and detached to windows. Detach can happen either through the context menu or by dragging a tab out of the strip. A detached conversation returns only when the user clicks its Return to Tab button; native window movement has no docking behavior.

## State Management

### Renderer State (`state.js`)

```javascript
// `control` is tracked for bookkeeping but filtered out of the visible
// tab strip via getVisibleTabOrder(); only `chat` renders as a permanent tab.
state.tabOrder = ['control', 'chat', 'conv-id-1', 'conv-id-2', ...];
state.tabMeta = {
  control: { title: 'Control Plane', type: 'permanent' },
  chat: { title: 'Chat', type: 'permanent' },
  'conv-id-1': {
    title: 'New Chat',
    autoTitle: 'Debug OAuth flow',
    customTitle: null,
    conversationId: 'conv-id-1',
    type: 'chat',
    url: 'http://localhost:3789/c/conv-id-1',
  },
};
```

### Persistence

Tab state is serialized to `localStorage` under key `portico-tab-state` on every mutation (tab add/remove/reorder/rename/switch). On restart, `loadPersistedTabState()` restores tabs in order.

### Title Priority

Display title = `customTitle` > `autoTitle` > `title` > `'Chat'`

- `autoTitle` is set by the `page-title-updated` WebContents event
- `customTitle` is set by user rename (double-click or context menu)
- Generic shell titles such as `Open WebUI` are ignored so a fresh chat tab can keep the `New Chat` placeholder until a real conversation title exists

## IPC Channels

### Renderer -> Main (new)

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `set-active-view-key` | send | `viewKey: string` | Tell main process which OWUI view is active in the window |
| `open-new-chat-tab` | send | (none) | Forwarded back to renderer to trigger `openNewChatTab()` |
| `close-active-tab` | send | (none) | Forwarded back to renderer to trigger `closeActiveTab()` |
| `switch-to-tab-index` | send | `index: number` | Switch to tab at position (0-based) |
| `switch-tab-next` / `switch-tab-prev` | send | (none) | Cycle to adjacent tab |

### Main -> Renderer (new)

| Channel | Payload | Purpose |
|---|---|---|
| `open-new-chat-tab` | (none) | Tells renderer to create a new chat tab |
| `open-conversation-tab` | `url, conversationId, options?` | Open a specific conversation tab, reusing shell routing metadata like target-message reveal |
| `close-active-tab` | (none) | Tells renderer to close the active dynamic tab |
| `switch-to-tab` | `tabName: string` | Switch to a specific tab (used by navigate-to-conversation-window) |
| `switch-to-tab-index` | `index: number` | Switch to tab at position |
| `switch-tab-next` / `switch-tab-prev` | (none) | Cycle tabs |

### Main Process State (`owui-views.js`)

```javascript
const activeViewKeys = new Map(); // windowId -> viewKey
```

`setActiveViewForWindow(windowId, viewKey)` is called when the renderer switches tabs or when a detached chat window gains focus. `getActiveViewKeyForWindow(windowId)` checks the explicit map first, validates that the view still belongs to that exact window and is still visible, then falls back to scanning visible views for the same window only. Non-chat shell tabs now clear their active-view entry instead of leaving stale chat ownership behind.

`sendToActiveViewForWindow(windowId, channel, payload)` sends IPC only to the active tab's OWUI view. It remains the delivery path for Shift+CMD+F global search and for shell-to-view navigation such as scroll-to-message. CMD+F local find now resolves to the owning shell window renderer even when the native local-find overlay itself has focus, while still driving native `findInPage` against the active OWUI view. CMD+G and Shift+CMD+G provide next/prev navigation in local find only. Native local-find sessions are keyed by `BrowserWindow`, so attached and detached chats cannot clear, advance, or reuse each other's search state.

## Keyboard Shortcuts

All shortcuts are intercepted in `main.js` `before-input-event` handler:

| Shortcut | Handler |
|---|---|
| CMD+N / CMD+T | Send `open-new-chat-tab` to main window |
| CMD+F | Resolve the owner window, then send `find-in-page-open` to that shell window renderer |
| Shift+CMD+F | Send `trigger-search` to the active OWUI view |
| CMD+G | Resolve the owner window, then send `find-in-page-next` (find next) to that shell window renderer |
| Shift+CMD+G | Resolve the owner window, then send `find-in-page-prev` to that shell window renderer |
| CMD+W | Main window: send `close-active-tab`; Detached window: close window |
| CMD+1-9 | Send `switch-to-tab-index` with 0-based index into the visible tab order (control excluded), so CMD+1 → `chat`, CMD+2 → first dynamic tab. Control Plane is not reachable by number. |
| CMD+SHIFT+] | Send `switch-tab-next` |
| CMD+SHIFT+[ | Send `switch-tab-prev` |

## Tab Bar Component (`tab-bar.js`)

The tab bar is a vanilla JS component managing the DOM tab strip:

- **Scroll overflow**: Horizontal overflow with scroll buttons and mouse wheel support
- **Drag-to-reorder**: HTML5 drag-and-drop for non-permanent tabs with drop indicator
- **Drag-out detach**: If a dynamic tab is released outside the strip threshold, it detaches into its own `BrowserWindow`
- **Context menu**: Right-click menu with Rename, Close, Close Others, Close to Right, Detach
- **Inline rename**: Double-click tab name or use context menu rename for in-place editing
- **Middle-click close**: Auxclick on dynamic tabs
- **Close button**: Visible on hover/active, hidden otherwise
- **Tab limit**: `MAX_VISIBLE_TABS = 5` visible tabs (permanent `chat` + up to 4 dynamic tabs); shows notification when limit reached

API exposed via `window.tabBar`:

- `addTab(tabId, options)` -- Create tab button in strip
- `removeTab(tabId)` -- Remove tab button and clean up state
- `setActive(fullTabId)` -- Highlight active tab
- `updateTitle(tabId, title)` -- Update label text and tooltip
- `setActivity(tabId, { busy, phase })` -- Toggle per-tab busy spinner state
- `getTabAtIndex(n)` -- Get fullTabId at position
- `getNextTab(fullTabId)` / `getPrevTab(fullTabId)` -- Adjacent tab navigation

## Background Tab Suspension

Background conversation tabs are suspended based on idle time, not a tab-count threshold. The relevant constants in `chat-tab.js`:

- `BACKGROUND_TAB_UNLOAD_GRACE_MS = 15 * 60 * 1000` -- a background tab must have been inactive for 15 minutes before it is eligible to unload.
- `BACKGROUND_TAB_WARM_CACHE_LIMIT = 1` -- the most recently used background tab is always kept warm (mounted), so only background tabs beyond the first are candidates for unload.

When an eligible tab is unloaded, its OWUI view is destroyed to free memory and added to `suspendedTabs`. When the user switches to a suspended tab, the view is recreated and the URL reloaded. The tab button remains in the strip throughout.

Tracking uses `tabLastActive` timestamps and `tabBecameInactiveAt` markers, both maintained by `updateConversationTabActiveTimestamps()` on every `switchTab()` call. A timer (`getNextBackgroundUnloadDelay()`) schedules the next unload pass.

Tabs are protected from suspension (`isConversationTabUnloadProtected()`) when they are the active tab, are marked busy, have `attentionRequired`, or have pending backend modal prompts -- so background generations/tool work keep their live OWUI view until they finish.

## Component Map

### New Files

| File | Layer | Purpose |
|---|---|---|
| `docs/howto/users/tabs.md` | Documentation | User guide |
| `docs/architecture/chat-ui/tabs.md` | Documentation | This file |

### Modified Files

| File | Layer | Changes |
|---|---|---|
| `electron-app/src/renderer/state.js` | State | Added `tabOrder`, `tabMeta`, persist/load/display-title helpers; persists custom titles for the permanent `chat` tab while leaving `control` fixed |
| `electron-app/src/renderer/views/index.html` | Electron Shell | Replaced `.tab-navigation` with `.tab-bar-container` / `.tab-strip` (permanent `chat` tab + dynamic tabs + button + scroll arrows); Control Plane moved out of the strip to a `#control-plane-toggle` header button with a `#control-tab` panel |
| `electron-app/src/renderer/views/index.js` | Electron Shell | Tab IPC listeners, tab state restoration on DOMContentLoaded, restores the permanent `chat` tab custom title |
| `electron-app/src/renderer/views/conversation-window.html` | Electron Shell | Loads detached-window title chrome and the shared shell-owned local-find controller |
| `electron-app/src/renderer/views/conversation-window.js` | Electron Shell | Detached title rename, explicit button-only attach payload normalization, active-view sync on focus, and native find forwarding |
| `electron-app/src/renderer/components/chat-tab.js` | Electron Shell | `openNewChatTab()`, refactored `openConversationTab()` to use `tabBar.addTab`, enhanced `closeConversationTab()` with adjacent-tab switch, `closeOtherTabs()`, `closeTabsToRight()`, `closeActiveTab()`, `switchTab()` updates or clears the active view key and persists state, background tab suspension, `page-title-updated` auto-title listener, detach flows reuse live OWUI view identity and current conversation URL |
| `electron-app/src/renderer/components/owui-host.js` | Electron Shell | Added `page-title-updated` case to `handleOwuiEvent` |
| `electron-app/src/services/owui-views.js` | IPC | `activeViewKeys` Map, strict per-window `setActiveViewForWindow()`, `sendToActiveViewForWindow()`, `page-title-updated` forwarding in `bindWebContentsEvents()`, and window-aware native `findInPage` routing |
| `electron-app/src/services/ipc.js` | IPC | `set-active-view-key`, `open-new-chat-tab`, `close-active-tab`, `switch-to-tab-index`, `switch-tab-next/prev`, and explicit `conversation-attach` handlers; updated `navigate-to-conversation-window` to reuse open tabs or send `open-conversation-tab` when a result targets a chat that is not already open |
| `electron-app/src/renderer/components/tab-bar.js` | Electron Shell | Renameable permanent `chat` tab, native context menu capability gating, and inline title editing |
| `electron-app/src/services/preload.js` | IPC | Exposed `setActiveViewKey`, `onOpenNewChatTab`, `onCloseActiveTab`, `onSwitchToTabIndex`, `onSwitchTabNext`, `onSwitchTabPrev`, explicit detached-window attach, and detached-window title sync |
| `electron-app/src/services/main.js` | Electron Shell | CMD+F opens local find, Shift+CMD+F opens global search, CMD+G/Shift+CMD+G navigate next/prev in both surfaces, CMD+SHIFT+N opens a new chat window, CMD+N/CMD+T send `open-new-chat-tab` to the main window, CMD+W distinguishes main vs detached window, added CMD+1-9 and CMD+SHIFT+[/] shortcuts |
| `electron-app/src/services/bootstrap.js` | Electron Shell | Window menu exposes both New Tab and New Chat Window, Edit menu accelerators match the global/local search shortcuts, removed per-tab Window menu entries |
| `electron-app/src/styles.css` | Electron Shell | Replaced `.tab-navigation` styles with `.tab-bar-container`, `.tab-strip`, `.tab-scroll-btn`, `.tab-new-btn`, `.tab-rename-input`, `.tab-drop-indicator`, native-menu-safe trailing tab status badge styling, unified accent tokens, detached-title inline editor, unread dot, and compact busy spinner treatment; tab label truncation with ellipsis |
