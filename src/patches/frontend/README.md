# Frontend Patches for Open WebUI

This directory contains patched frontend files that are copied over the Open WebUI source during Docker build.

## Patch Structure

The directory structure mirrors the Open WebUI source:

```
src/patches/frontend/
└── src/lib/
    ├── components/chat/
    │   └── Chat.svelte                  # Tool call history preservation
    ├── components/layout/
    │   ├── Sidebar.svelte               # Sidebar width + drawer surfaces
    │   ├── Navbar/
    │       └── Menu.svelte             # Chat menu "Open Workspace" action
    │   └── Sidebar/
    │       ├── ChatItem.svelte          # Sidebar chat row hover/menu surfaces
    │       └── ChatMenu.svelte          # Sidebar ellipsis menu theming
    ├── stores/
    │   └── index.ts                     # Default sidebar width store override
    ├── utils/
    │   ├── text-scale.ts                # Compact default UI scale baseline
    └── utils/marked/
        └── extension.ts                 # Markdown extensions
```

## How Patches Are Applied

During Docker build (`Dockerfile.open-webui-patched`):

1. Clone Open WebUI at specific version
2. Copy `src/patches/frontend/` → `/build/` (overwrites source files)
3. Verify patches are present (build fails if missing)
4. Build frontend with patched files
5. Copy built frontend to final image

## Current Patches

### Chat.svelte - Tool Call History Preservation

**File**: `src/lib/components/chat/Chat.svelte`
**Line**: 1885
**Change**: Added `...(message.contentBlocks && { contentBlocks: message.contentBlocks }),`

**Purpose**: Preserve contentBlocks field when sending messages to backend API.

**Why needed**: 
- Backend saves messages with contentBlocks (structured Anthropic format)
- Frontend retrieves contentBlocks from database
- Frontend was dropping contentBlocks when building API request
- Backend needs contentBlocks to reconstruct proper tool_calls, reasoning, results

**Impact**: Enables Phoenix observability to track tool usage across conversation turns.

### index.ts - Clipboard Bridge + Browser Fallback

**File**: `src/lib/utils/index.ts`
**Marker**: `PORTICO_PATCH: Prefer the Electron host bridge`
**Purpose**: Keep copy-to-clipboard working in both Electron-hosted OWUI and direct browser sessions.

**Change**:
- Prefer `window.webviewHost.writeClipboard(...)` when OWUI is running inside the Electron shell
- Fall back to the browser Clipboard API when running directly in a browser
- Fall back again to `document.execCommand('copy')` if `navigator.clipboard` exists but rejects

**Why needed**:
- Electron `WebContentsView` clipboard behavior can reject `navigator.clipboard` calls even when OWUI copy buttons are wired correctly
- Upstream OWUI only used the legacy textarea fallback when `navigator.clipboard` was missing, not when the async write failed
- Direct browser access should keep working without the Electron preload bridge

**Impact**: Restores copy actions in Electron while preserving browser-direct behavior and improving fallback reliability.

### extension.ts - Markdown Extensions

**File**: `src/lib/utils/marked/extension.ts`
**Marker**: `PATCHED_MARKER_v2`
**Purpose**: Custom markdown rendering behavior
**Status**: Pre-existing patch

### Sidebar.svelte / Sidebar/ChatItem.svelte / Sidebar/ChatMenu.svelte - Sidebar Width + Light Theme Surface Fixes

**Files**:
- `src/lib/components/layout/Sidebar.svelte`
- `src/lib/components/layout/Sidebar/ChatItem.svelte`
- `src/lib/components/layout/Sidebar/ChatMenu.svelte`

**Purpose**:
- Raise the default opened sidebar width to `360px` without changing the collapsed rail or resize behavior
- Remove the light-mode white flash during drawer open by keeping the drawer shell and gradient on the blue-gray sidebar surface
- Remove the light-mode white hover/menu surfaces around the sidebar chat ellipsis button and dropdown

**Why needed**:
- The stock OWUI sidebar opens too narrowly for this shell layout
- The light-mode drawer animation briefly exposed white surfaces that did not match the patched sidebar palette
- The sidebar chat ellipsis hover strip and dropdown still used bright white surfaces in light mode

**Impact**:
- Wider default opened drawer
- Consistent light-mode drawer animation
- Sidebar row and menu surfaces now match the existing blue-gray light theme

### stores/index.ts - Sidebar Width Store Default

**File**: `src/lib/stores/index.ts`

**Purpose**:
- Make the opened drawer default width `360px` from first render, not only after `Sidebar.svelte` mounts

**Why needed**:
- `Sidebar.svelte` already normalizes the width on mount, but the upstream store still initializes `sidebarWidth` to `260`
- Keeping the store default aligned prevents the drawer from briefly booting at the old width before the component applies its override

**Impact**:
- The opened sidebar starts at the wider default immediately
- Manual resize persistence still works as before

### text-scale.ts - Compact Default UI Density

**File**: `src/lib/utils/text-scale.ts`

**Purpose**:
- Rebase OWUI's existing UI Scale control onto a compact baseline that matches roughly `90%` browser zoom

**Why needed**:
- A document-level visual scale caused centering and layout regressions
- OWUI already routes interface scale through `setTextScale(...)`, so rebasing that function shrinks the UI without using `transform`/`zoom`

**Impact**:
- Default UI density is smaller across the app without component-by-component overrides
- Existing UI Scale controls still work, now relative to the compact baseline

### Navbar/Menu.svelte - Open Workspace Action

**File**: `src/lib/components/layout/Navbar/Menu.svelte`

**Purpose**:
- Add an `Open Workspace` action directly below `Copy Chat ID` in the active chat menu
- Open the chat's local workspace directory in Finder when OWUI is running inside the Electron shell

**Why needed**:
- Chats already write files into per-chat workspace folders under `workspaces/{chat_id}`
- Users need a direct way to inspect those files on disk from the current chat UI

**Impact**:
- Desktop users can open the current chat's workspace folder from the chat menu
- Browser-only OWUI sessions keep the item hidden because the Electron bridge is unavailable

### chatFork.ts + fork-chat action - Fork a Chat at an Assistant Message

**Files**: `src/lib/utils/chatFork.ts` (new), `src/lib/components/chat/Chat.svelte`, `src/lib/components/chat/Messages.svelte`, `src/lib/components/chat/Messages/Message.svelte`, `src/lib/components/chat/Messages/MultiResponseMessages.svelte`, `src/lib/components/chat/Messages/ResponseMessage.svelte` — patch sites marked `PORTICO PATCH (fork-chat)`

**Purpose**:
- Add a Fork button (`#fork-chat-button`, always the rightmost action under an assistant response) that creates a new chat truncated at exactly that message
- `chatFork.ts` builds the truncated history client-side (visible branch only, deep-copied, sibling branches pruned, multi-model turns collapsed onto the kept branch) and the `createNewChat` payload with `originalChatId`/`branchPointMessageId` provenance (same convention as the backend clone endpoint); tags/pinned are deliberately not copied
- The fork opens in a new Electron tab via `window.webviewHost.navigateToConversation`; at the 5-tab cap the shell redirects the active tab instead; detached windows and plain-browser sessions fall back to in-place `goto`

**Why needed**:
- Users want to branch a conversation from a specific response without disturbing the original chat

**Impact**:
- Fork button hidden on streaming/read-only/temporary-chat views; upstream consumers that don't pass `forkChat` render unchanged
- `chatFork.ts` must stay free of runtime imports — `tests/chat-fork.unit.test.js` bundles it standalone

## Adding New Patches

1. Copy patched file to corresponding location under `src/patches/frontend/`
2. Add verification step to `Dockerfile.open-webui-patched`
3. Document the patch in this README
4. Test by rebuilding Docker image

## Verification

All patches are verified during Docker build. Build will fail if any patch is missing.

Check build logs for:
```
✓ extension.ts patch verified (PATCHED_MARKER_v2 found)
✓ Chat.svelte patch verified (contentBlocks preservation found)
✓ utils/index.ts patch verified (clipboard bridge + browser fallback)
✓ Sidebar.svelte patch verified (360px default width + light drawer surfaces)
✓ Sidebar/ChatMenu.svelte patch verified (blue-gray light menu surfaces)
✓ Sidebar/ChatItem.svelte patch verified (light chat-row ellipsis surfaces)
✓ stores/index.ts patch verified (360px sidebar store default)
✓ text-scale.ts patch verified (0.9 compact scale baseline)
✓ Navbar/Menu.svelte patch verified (Open Workspace action)
✓ chatFork.ts found (fork-chat helpers)
```
