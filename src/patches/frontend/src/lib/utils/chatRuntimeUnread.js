// PORTICO-432: who owns the sidebar's "New activity" dot.
//
// Extracted from chatRuntimeState.ts so the rule is executable in tests. The
// store itself cannot be loaded locally (the frontend builds in Docker), and
// this one boolean IS the fix — left inline, a future refactor could quietly
// restore the union and bring the bug back.
//
// The rule: unread comes from the chat-scoped activity registry alone.
//
// The shell also tracks unread, but per TAB (tabMeta[tabId].unread), resolved
// to whichever chat that tab happened to be showing. It clears only when the tab
// is activated or reused, so opening a chat from the sidebar — in-page
// navigation, not a tab switch — could never clear it and the dot survived until
// restart. Because the flag belonged to the tab rather than the chat, it also
// followed the tab onto the next chat and flagged chats that never had activity.
//
// The registry already applies the same rule correctly at chat granularity:
// chat-runtime-registry.js reportActivity sets `unread = viewed ? false : true`
// on busy->idle, where `viewed` means a VISIBLE view shows that chat, and
// markViewed clears it on focus, visibility and active-view changes. Background
// tabs report visible:false (owui-host.js syncVisibility follows DOM
// visibility), so background completions are still caught.
//
// attentionRequired keeps its union: that signal is genuinely shell-owned
// (native input prompts) and is not part of this bug.

// Typed with JSDoc because the frontend tsconfig sets checkJs + strict, so an
// untyped default of `null` would infer as `null` and every property read below
// would fail `npm run check`. The image build (vite build) does not typecheck,
// but lint:types does.

/**
 * @typedef {object} ChatActivityState
 * @property {boolean} [busy]
 * @property {string} [phase]
 * @property {boolean} [unread]
 * @property {boolean} [attentionRequired]
 */

/**
 * @typedef {object} ChatShellState
 * @property {boolean} [unread]
 * @property {boolean} [attentionRequired]
 */

/**
 * @param {object} [input]
 * @param {ChatActivityState | null} [input.activity]
 * @param {ChatShellState | null} [input.shellState]
 * @param {boolean} [input.nativeInputAttention]
 * @returns {{ busy: boolean, phase: string, unread: boolean, attentionRequired: boolean }}
 */
export const resolveChatRuntimeEntry = ({
  activity = null,
  shellState = null,
  nativeInputAttention = false
} = {}) => ({
  busy: activity?.busy === true,
  phase: activity?.busy === true && activity?.phase ? activity.phase : 'idle',
  unread: activity?.unread === true,
  attentionRequired:
    activity?.attentionRequired === true ||
    shellState?.attentionRequired === true ||
    nativeInputAttention === true
});
