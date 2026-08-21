# Search in Portico

Search lets you find messages across all your conversations or within the current chat. It works like Slack's search -- press a shortcut, type your query, and jump straight to the result.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| **CMD+F** | Open **Find in Current Chat** -- quick search inside the active conversation |
| **Shift+CMD+F** | Open **Search Conversations** -- cross-conversation message search |
| **CMD+G** | Jump to the next match in local find (restores previous query if the bar was closed) |
| **Shift+CMD+G** | Jump to the previous match in local find (restores previous query if the bar was closed) |
| **ESC** | Close whichever search UI is active |
| **Enter** | Navigate to the selected result / next match |
| **Shift+Enter** | Previous match (Find in Current Chat) |
| **Arrow Up/Down** | Navigate through search results |

Both shortcuts are also available from the **Edit** menu.

## Searching Across Conversations (Shift+CMD+F)

Pressing **Shift+CMD+F** opens the Search Conversations modal. This searches conversation titles and the visible message content of every conversation.

### How to Use

1. Press **Shift+CMD+F** or click the search icon in the sidebar.
2. Start typing your query. Results appear after a short delay.
3. The results list is unified: title-only matches open the conversation directly, while snippet matches jump to the exact message.
4. Click a specific snippet row to navigate to that conversation and scroll to the exact matched message.

### Filters

A filter bar appears below the search input when you have an active query:

- **Time scope**: All | Today | This Week | This Month
- **Message role**: All Messages | My Messages | AI Responses

Click a filter pill to toggle it. Active filters are highlighted in blue.

### Advanced Options

Two toggle buttons sit to the right of the search input:

- **Aa** -- Case-sensitive search. When active, "Error" won't match "error".
- **.\*** -- Regular expression mode. Use regex patterns like `error.*timeout` or `\d{3}\s+response`.

When regex mode is off, search treats punctuation literally. Queries like `"hello"`, `server:mcp-assistant`, `(foo)`, or `{bar}` are searched as plain text instead of regex or FTS syntax.

### Suggestions

When the search input is empty and focused, a single suggestions panel appears under the field. It combines:

- Your 10 most recent searches
- Built-in search tips for filters and quick navigation

Click any recent entry to re-run that search.

### Result Layout

Each conversation result can show:
- The conversation title, with matched text highlighted in yellow
- A match count badge (e.g., "5 matches")
- Independently clickable message snippets with the search term highlighted
- A role tag (You / AI) next to each snippet
- The date of last activity

If a query only matches the conversation title, that result opens the chat directly. If a query matches message content, the matching snippets appear under the same conversation row.

Results come from conversation titles and visible message text. Persisted structured assistant output such as tool calls, tool results, and reasoning blocks is not searched.

### Navigating to a Result

When you click a snippet result:
1. The app navigates to that conversation.
2. The page scrolls to the specific message.
3. A brief yellow highlight animation marks the target message.

If the conversation is already open in another tab, that tab is activated before scrolling to the message. Otherwise the app opens that conversation in a new tab in the current window and then jumps to the matched message.

## Finding Text in the Current Chat (CMD+F)

Pressing **CMD+F** opens a browser-like floating find overlay owned by the shell window, but rendered in a dedicated native child overlay above the active chat surface and anchored near the chat action icons. It uses Chromium's native find engine for the current conversation, highlights exact term matches inside the transcript, and does not add a new row or push the transcript down.

### How to Use

1. Press **CMD+F** or select **Edit > Find in Current Chat**.
2. If this is your first search, the input starts empty. If you previously searched and closed the bar, the previous query is restored and pre-selected so you can immediately type to replace it or press **CMD+G** to continue navigating.
3. Type in the find overlay. Native text matches are highlighted directly in the active chat.
4. A counter shows "N of M" for the current transcript result position and does not count the find field itself.
5. Press **CMD+G**, **Enter**, or **ArrowDown** to jump to the next match. Press **Shift+CMD+G**, **Shift+Enter**, or **ArrowUp** for the previous. Pressing **CMD+F** again while the bar is open restores the query but does not advance.
6. Press **ESC** to close the bar and clear the active search selection.

### Focus Behavior

- Match updates do not treat the find field itself as a result, so Chromium only highlights transcript matches and never the local-find input.
- Focus stays in the local-find input while you type, delete, or navigate matches. Only clicking outside the overlay or closing it releases focus ownership.
- Clicking outside the local-find overlay releases focus ownership. Clicking back into the overlay restores it.
- The shell controller publishes local-find visibility back into the active chat view so other search surfaces do not compete for focus while local find is active.

### Options

- **Aa** -- Case-sensitive toggle (same as in the modal).
- The same native shell-owned in-chat find overlay appears in detached chat windows, so local find behaves the same whether the chat is attached or detached.
- Each tab or detached window keeps its own local-find session. Searching in one chat does not clear or advance matches in another.
- If older messages from the current conversation are not loaded yet, previous/next navigation reveals enough history to reach those hidden matches without changing normal chat scrolling outside local find.

## Tips

- Use regex for complex patterns: `\berror\b` matches the word "error" but not "errors".
- Combine scope filters with role filters to narrow results, e.g., "My Messages" + "Today".
- The local find overlay (CMD+F) targets whichever chat tab or detached chat window owns the focused search surface, so repeated shortcuts still act on the correct chat even while the overlay itself has focus.
- Search results are paginated with infinite scroll -- keep scrolling to load more.

<!-- Screenshots to be added after implementation testing -->
