# Tabs in Portico

Portico uses a browser-style tab bar to organize your conversations. The **Chat** tab is always available; new chats open in their own tabs that you can close, reorder, and rename. **Control Plane** is not a tab -- it opens from a separate toggle button in the window header.

## Tab Layout

The tab bar sits in the window header:

1. **Chat** (permanent, leftmost in the tab strip) -- OWUI home / new chat landing page
2. **Dynamic tabs** (to the right) -- individual chat sessions, closeable and reorderable

A **+** button at the end of the tab strip creates a new chat tab.

**Control Plane** (MCP server management, settings) is opened from its own toggle button in the header's right-side controls, not from the tab strip.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| **CMD+N** / **CMD+T** | Open a new chat tab |
| **CMD+SHIFT+N** | Open a new chat window |
| **CMD+W** | Close the active tab (permanent tabs cannot be closed) |
| **CMD+1** through **CMD+5** | Switch to tab strip position (CMD+1 → Chat, CMD+2 → first dynamic tab, ...) |
| **CMD+SHIFT+]** | Next tab |
| **CMD+SHIFT+[** | Previous tab |
| **CMD+F** | Find in current chat (active tab only) |
| **Shift+CMD+F** | Search across all conversations (opens in active tab) |
| **CMD+G** | Next match in local find |
| **Shift+CMD+G** | Previous match in local find |

## Opening Tabs

- Press **CMD+N** or click the **+** button to open a new chat.
- Press **CMD+SHIFT+N** to open a new chat in its own window.
- When a subagent opens a conversation, it appears as a new tab automatically.
- Tabs restore automatically on restart -- your open tabs and their order are preserved.

## Closing Tabs

- Click the **X** on a tab, or press **CMD+W** when the tab is active.
- **Middle-click** a tab to close it.
- Right-click a tab for bulk actions: *Close*, *Close Other Tabs*, *Close Tabs to the Right*.
- The permanent **Chat** tab hides close/detach actions that do not apply to it, but it still supports rename.
- When you close the active tab, the adjacent tab becomes active.
- The permanent **Chat** tab cannot be closed.

## Reordering Tabs

Drag any dynamic tab left or right to reorder. A blue indicator shows the drop position. The permanent **Chat** tab stays fixed. The new order is persisted across restarts.

## Renaming Tabs

- **Double-click** a tab name to start inline editing. Press Enter to confirm, Escape to cancel. The permanent **Chat** tab supports rename too.
- **Right-click > Rename Tab** starts the same inline edit flow from the context menu.
- Custom names are saved and take priority over auto-generated titles.
- New chat tabs start as **New Chat**. Generic page titles do not overwrite that placeholder.
- Tab titles update automatically from conversation content. If you set a custom name, it is preserved unless you clear it.

## Tab Names

Tab labels are truncated with an ellipsis if they exceed the maximum width. Hover over any tab to see the full name in a tooltip.

## Detaching to a Window

Drag a dynamic tab out of the tab strip to tear it off into a separate window, similar to a browser tab.

You can also right-click a dynamic tab and select **Detach to Window**.

Detached conversations open in their own window and are removed from the tab strip in the main shell. The detached window keeps the live conversation state instead of reloading to home.

Double-click the centered title in a detached chat window to rename it. When you return that window to the main shell, the custom title comes back with it.

To return any detached chat or subagent to the main shell, click the **Return to Tab** button in its header. Dragging the detached window over the tab strip does not redock it.

The permanent **Chat** tab stays in the main window.

## Activity Indicators

If a conversation is still generating or has active background work, its tab shows a compact trailing spinner badge. When a background tab finishes new work, it also gets an orange unread dot until you activate that tab.

## Tab Limits

A maximum of 5 tabs can be visible at once in the tab strip -- the permanent **Chat** tab plus up to 4 dynamic chat tabs. If you hit the limit, close some tabs before opening new ones. Background chat tabs that have been idle for 15 minutes may be suspended to save memory and reload automatically when you switch back; the most recently used background tab is kept warm, and tabs with active generation or pending prompts are never suspended.

## Tips

- Use **CMD+1** to quickly jump to the Chat home tab; **CMD+2** and up jump to your dynamic chat tabs in order. Control Plane is opened from its toggle button in the header, not by a number shortcut.
- Search results (Shift+CMD+F) span all conversations regardless of which tab is active. Clicking a result reuses the existing tab for that conversation or opens a new one in the current window before jumping to the message.
- Local find (CMD+F) searches the active chat tab or detached chat window. The search query and case-sensitivity toggle are remembered across tabs — opening find on a new tab pre-fills the previous query (selected for easy replacement).
- New chat tabs start with the title "New Chat" and update automatically as you begin a conversation.
