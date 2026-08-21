# Search Feature -- Technical Architecture

## Overview

The search feature spans four architecture layers:

| Layer | Role |
|---|---|
| **Chat UI** (OWUI Svelte) | SearchModal, unified suggestions panel, message-result presentation |
| **Electron Shell** | Keyboard shortcut interception, native `findInPage` routing, detached-window parity |
| **IPC/Communication** | Bridge between Electron main process, shell renderer, and OWUI webContents |
| **State & Persistence** | SQLite regular tables with B-tree indexes (`instr()` substring matching), localStorage for search history |

## Requirements

### Functional

- FR-1: CMD+F opens browser-like local find for the current conversation
- FR-2: Shift+CMD+F opens cross-conversation message-level search
- FR-3: Results render as a unified conversation list with title and per-message snippet hits returned by a single endpoint
- FR-4: Message snippets with highlighted search terms and independently clickable match rows
- FR-5: Click-to-navigate with scroll-to-message and highlight flash
- FR-6: Scope filters (All, Today, This Week, This Month, My Messages, AI Responses)
- FR-7: Case-sensitive and regex toggles
- FR-8: Recent searches (last 10, localStorage-backed)
- FR-9: Edit menu items with accelerator hints
- FR-10: ESC closes any open search UI
- FR-11: Multi-tab awareness (tab switching before scroll-to-message)
- FR-12: In-chat match counter ("N of M") with prev/next navigation
- FR-13: CMD+G / Shift+CMD+G navigate forward/backward in local find
- FR-14: Result count badge in SearchModal footer

### Non-Functional

- NFR-1: In-chat local search stays responsive by reusing Chromium `findInPage` instead of scanning the rendered transcript in OWUI
- NFR-2: Cross-conversation search < 1s (`instr()` substring matching with B-tree pagination)
- NFR-3: No new polling loops or recurring IPC broadcasts
- NFR-4: Theme-aware (light/dark)
- NFR-5: Find bar non-blocking (chat interaction continues)
- NFR-6: Paginated results (10 conversation groups per page)
- NFR-7: B-tree indexed pagination with `instr()` substring search; FTS5 trigram can be enabled as a future optimisation if performance requires it

## Data Flow

### CMD+F Bridge (Electron -> OWUI)

```
User presses CMD+F
    -> main.js before-input-event interceptor
    -> event.preventDefault()
    -> owuiViews.sendToActiveViewForWindow(focusedWin.id, 'trigger-search', {})
    -> Only the active tab's OWUI view receives the event
    -> chat-webview-preload.js: ipcRenderer.on('trigger-search')
    -> window.dispatchEvent(CustomEvent('trigger-search'))
    -> Sidebar.svelte: showSearch.set(true)
    -> SearchModal.svelte opens
    -> Search backend still searches ALL conversations (not tab-scoped)
```

### Message Search Flow

```
User types query in SearchModal
    -> 500ms debounce
    -> searchChatMessages() API call
    -> GET /api/v1/chats/search/messages?text=...&cursor=...&size=...&role=...&updated_since=...&case_sensitive=...&regex=...
    -> chats.py endpoint
    -> chat_search.search_messages()
    -> Single unified query: JOIN chat table with chat_search_conversations using cursor-based pagination
    -> instr() substring matching on title and body columns (no FTS5 tokenisation)
    -> Both title and message hits discovered in one pass, grouped by chat on the backend
    -> Server-side title highlighting with <mark> tags (title_html field)
    -> Regex search extracts literal segments as instr() pre-filters, then applies Python re.search() with eval budget
    -> Results ordered by conversation updated_at DESC, chat_id DESC (cursor-stable)
    -> Every matched message contributes to match_count, while snippet previews are capped per conversation
    -> Response: { results, has_more, next_cursor, index_status, regex_budget_exhausted }
```

### Scroll-to-Message Flow

```
User clicks a search result
    -> SearchModal.navigateToMessage(chatId, messageId)
    -> Check webviewHost.navigateToConversation(chatId, messageId, { title })
       -> IPC: navigate-to-conversation-window
       -> Main process: find tab with matching conversationId
          -> If found: switch that tab and send 'navigate-to-message' into that OWUI view
          -> If not found: send 'open-conversation-tab' to the tabbed shell window with /c/{chatId}?portico-target-message={messageId}
       -> Sidebar.svelte consumes the one-shot URL param in the target tab and calls revealMessageWithRetry()
    -> Result: existing tab is reused when present; otherwise a new tab opens in the current shell window before reveal
```

### In-Chat Search Flow (CMD+F)

```
User presses CMD+F
    -> main.js before-input-event
    -> Resolve the owner BrowserWindow if a native local-find overlay currently has focus
    -> ownerWindow.webContents.send('find-in-page-open')
    -> renderer/components/find-bar.js opens or advances a shell-owned local-find session
    -> windows.js ensures a dedicated native child overlay window stays above the OWUI WebContentsView
    -> The shell controller keeps focus/caret state and stays outside the searched OWUI DOM
    -> find-bar.js uses electronAPI.owui.executeJavaScript(viewKey, ...) to:
       - measure the active chat action area for placement
       - publish local-find active state into the OWUI page
       - request one-shot hidden-history expansion when needed
    -> User types in the native shell-owned in-chat overlay
    -> local-find-overlay-preload.js forwards query/button/blur events back to the owning shell renderer
    -> ipc.js: owui-find-in-page
    -> owui-views.js: findInPage(text, options, windowId)
    -> Active OWUI WebContentsView for that BrowserWindow runs Chromium findInPage()
    -> found-in-page results flow back into the owning shell renderer only
    -> renderer/components/find-bar.js updates the counter without changing query text or caret
```

## Search Schema (v11)

### Conversation Table

```sql
CREATE TABLE IF NOT EXISTS chat_search_conversations (
    chat_id TEXT NOT NULL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    body_content TEXT NOT NULL DEFAULT '',
    user_content TEXT NOT NULL DEFAULT '',
    assistant_content TEXT NOT NULL DEFAULT '',
    updated_at REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_search_conv_user_updated
    ON chat_search_conversations (user_id, updated_at DESC, chat_id DESC);
```

Role-specific columns (`user_content`, `assistant_content`) enable role-filtered search without scanning the message table.

### Message Table

```sql
CREATE TABLE IF NOT EXISTS chat_search_messages (
    chat_id            TEXT NOT NULL,
    message_id         TEXT NOT NULL,
    role               TEXT NOT NULL DEFAULT 'unknown',
    body_content       TEXT NOT NULL DEFAULT '',
    structured_content TEXT NOT NULL DEFAULT '',
    timestamp          REAL NOT NULL DEFAULT 0,
    user_id            TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_search_msg_chat
    ON chat_search_messages (chat_id, timestamp DESC);
```

The searchable payload is split intentionally:

- `body_content`: visible message text that participates in search
- `structured_content`: structured assistant output such as tool calls, tool results, reasoning blocks, and legacy thinking tags (indexed but not searched)

### Meta Table

```sql
CREATE TABLE IF NOT EXISTS chat_search_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
```

Tracks population state and schema version to avoid re-indexing on every restart.

### Population Strategy

- **Initial**: On first search, `ensure_search_populated()` scans the raw chat table, skips invalid chat JSON rows, and commits per chat so one bad row does not derail the full rebuild.
- **Incremental**: After every chat update (`POST /api/v1/chats/{id}`), `sync_chat_to_search()` deletes all rows for that chat_id and re-inserts current messages.
- **Deletion**: When a chat is deleted, `delete_chat_from_search()` removes its rows.

### Performance Characteristics

- `instr()` substring matching: < 50ms for typical corpus (200–1K conversations)
- B-tree index on `(user_id, updated_at DESC, chat_id DESC)` accelerates cursor pagination
- Exact substring semantics: punctuation-heavy queries (`"hello"`, `server:mcp-assistant`) work without escaping
- Population time: ~1s for 1000 chats with 50 messages each (one-time)
- Future path: FTS5 trigram indexing can be enabled for queries ≥ 3 chars if performance requires it

## API Contract

### GET /api/v1/chats/search/messages

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| text | string | yes | - | Search query |
| cursor | string | no | - | Opaque cursor for next page (`updated_at:chat_id`) |
| size | int | no | 10 | Results per page (max 50) |
| role | string | no | all | "user" or "assistant" |
| updated_since | float | no | - | Unix timestamp; only return conversations updated after this time |
| case_sensitive | bool | no | false | Case-sensitive matching |
| regex | bool | no | false | Treat text as regex pattern |

**Response Model:**

```json
{
  "results": [
    {
      "chat_id": "uuid",
      "title": "Debug Docker OAuth flow",
      "title_html": "Debug Docker <mark>OAuth</mark> flow",
      "updated_at": 1710072000.0,
      "title_matched": true,
      "match_count": 3,
      "matches": [
        {
          "message_id": "uuid",
          "role": "user",
          "snippet": "...tried the <mark>error handling</mark> path but...",
          "timestamp": 1710071500.0
        }
      ]
    }
  ],
  "has_more": true,
  "next_cursor": "1710072000.0:chat-uuid",
  "index_status": { "state": "ready" },
  "regex_budget_exhausted": false
}
```

Each page returns up to `size` conversation groups (default 10). `match_count` reflects the total matched messages found for that conversation, while the previewed `matches` list is capped to keep cards compact. Results are ordered by `updated_at DESC, chat_id DESC` with stable cursor-based pagination. `title_html` contains server-side highlighted title with `<mark>` tags. `next_cursor` is `null` when `has_more` is `false`. `regex_budget_exhausted` is `true` in regex mode when the per-request eval budget is hit before the full corpus is scanned.

## Component Map

### New Files

| File | Layer | Purpose |
|---|---|---|
| `src/patches/backend/open_webui/utils/chat_search.py` | State & Persistence | Search table management, population, instr()-based search logic |
| `src/patches/frontend/src/lib/apis/chatSearch.ts` | Chat UI | API client for message-level search |
| `docs/howto/users/search.md` | Documentation | User guide |
| `docs/architecture/chat-ui/search.md` | Documentation | This file |

### Modified Files

| File | Layer | Changes |
|---|---|---|
| `electron-app/src/services/main.js` | Electron Shell | CMD+F, Shift+CMD+F, CMD+G, Shift+CMD+G shortcut interception in before-input-event |
| `electron-app/src/services/bootstrap.js` | Electron Shell | Edit menu items for Find in Current Chat and Search Conversations |
| `electron-app/src/renderer/views/conversation-window.js` | Electron Shell | Detached-window active-view sync, title synchronization, and attach/detach parity |
| `electron-app/src/renderer/components/find-bar.js` | Electron Shell | Shell-owned local-find controller, browser-style focus/caret state, placement, and hidden-history bridge |
| `electron-app/src/renderer/views/local-find-overlay.html` | Electron Shell | Dedicated native child overlay renderer for the visible CMD+F local-find chrome |
| `electron-app/src/services/local-find-overlay-preload.js` | IPC/Communication | Bridges overlay input/button/blur events back to the owning shell renderer |
| `electron-app/src/services/chat-webview-preload.js` | IPC | trigger-search bridge and other OWUI preload integrations; no longer owns visible local-find UI |
| `src/patches/frontend/src/lib/components/layout/SearchModal.svelte` | Chat UI | Message-level search modal, unified suggestion surface, filters, and retryable error UI |
| `src/patches/frontend/src/lib/components/layout/Sidebar.svelte` | Chat UI | trigger-search event listener and one-shot URL-target message reveal |
| `src/patches/frontend/src/app.css` | Chat UI | Shared search accent tokens for modal suggestion and filter styling |
| `src/patches/backend/open_webui/routers/chats.py` | State & Persistence | /search/messages unified endpoint, search sync hooks |

## Design Decisions

### Why a separate search index over JSON scanning?

Chat messages are stored as JSON blobs inside the `chat` column. Scanning every chat's JSON on each search would be O(N*M) where N = chats, M = messages per chat. Pre-extracted regular tables with B-tree indexes provide fast cursor-based pagination and `instr()` substring matching, keeping search responsive as chat history grows. If performance becomes an issue at extreme scale, FTS5 trigram indexing can be layered in without changing the API contract.

### Why enhance SearchModal vs build new?

The existing SearchModal already has debouncing, keyboard navigation, pagination, modal overlay, and sidebar integration. Rebuilding would duplicate this infrastructure. The enhancement adds message-level results and advanced features while preserving the existing UX patterns.

### Why CMD+F for local find and Shift+CMD+F for global search?

CMD+F follows the standard macOS/browser convention for find-in-page. Shift+CMD+F extends that convention for the broader cross-conversation search. CMD+G and Shift+CMD+G provide consistent next/prev navigation across both search surfaces, matching standard macOS behavior.

### Tab-scoped modal vs cross-tab search

The SearchModal renders in the active tab's OWUI view (triggered via `sendToActiveViewForWindow`), but the search backend always searches across all conversations. This means the modal appears contextually in the active tab, but results span all chats. Title hits and message hits are merged into one conversation-level result list before rendering. Clicking a result from a different conversation now resolves the correct shell tab first: reuse an existing tab if present, otherwise open a new tab in the current shell window and reveal the message there. CMD+G remains strictly scoped to the active tab or detached window's current OWUI view through native `findInPage`, while its lightweight controls now live in a shell-owned native child overlay that stays outside the searched DOM, stays above the `WebContentsView`, and avoids reserving a separate toolbar row. Per-window native find routing means two chat windows never share match state.

### Why split visible content from agent traces?

Search only matches against `body_content` — what the user can actually read in the transcript. Structured assistant output (tool calls, reasoning blocks, legacy thinking tags) is still indexed into the `\structured_content` column for potential future use, but it is not searched. This keeps the result set aligned with visible chat content and avoids surfacing hidden reasoning/tool payloads unexpectedly.

### Why treat punctuation literally outside regex mode?

Users expect a plain search for text like `"hello"`, `server:mcp-assistant`, or `(foo)` to match those literal characters. The v11 search uses `instr()` directly on regular tables, so all characters are matched literally by default — no tokeniser to misinterpret punctuation. Regex mode is opt-in and uses a separate code path with safety guards.

### Why move CMD+G back to a shell-owned overlay?

The remaining regressions came from putting the local-find input inside the same OWUI document that Chromium `findInPage` was scanning. That made the input itself eligible as a match, forced self-hit normalization, and kept focus recovery coupled to the searched DOM. The final design splits responsibilities: `find-bar.js` remains the shell-side session/controller, while a native child overlay window owns the visible input and buttons. That keeps the input off the search surface entirely, preserves the browser-like contract in one shell workflow, holds caret ownership until explicit click-away or close, routes repeated shortcuts back through the owning chat window, and uses one-shot `executeJavaScript()` calls only for placement, active-state publication, and hidden-history expansion inside the active OWUI view.

## Folder Convention

```
docs/
  howto/           <-- User-facing guides (how to use features)
    search.md
  architecture/    <-- Technical architecture per feature
    search.md
  ... (existing flat files, to be reorganized later)
```
