// Multi-chat tiling state. Written by MultiChatContainer (pane registry,
// focus) and by tile-mode Chat instances (per-pane runtime); read by the
// primary Chat's composer for cross-pane dispatch and by artifact routing to
// force windowed-only behavior. Purely event-driven — no timers.
import { derived, writable } from 'svelte/store';

import type { PaneCommand, PaneComposerRuntime } from '$lib/utils/multiChatComposerState';

export type MultiChatPane = {
	chat_id: string;
	display_name: string;
	created_at: number;
};

// Full composer-relevant per-pane state (models, effort, fast mode, params,
// context/cost, capabilities) — see multiChatComposerState.ts.
export type MultiChatPaneRuntime = PaneComposerRuntime;

// '' when the current view is not tiled; otherwise the ROOT chat id.
export const multiChatActiveRootId = writable<string>('');

// The chat id the shared composer dispatches to (defaults to the root).
export const multiChatFocusedChatId = writable<string>('');

// chatId -> live state published by each tile's Chat instance.
export const multiChatPaneRuntime = writable<Record<string, MultiChatPaneRuntime>>({});

// Composer-settings write-back channel: the primary posts a command when the
// user edits a widget while a tile is focused; the addressed tile applies it
// through its own handlers (which persist with tile-correct chat ids) and
// republishes its runtime. seq is monotonic so tiles can dedupe replays.
export const multiChatPaneCommands = writable<PaneCommand | null>(null);

let nextPaneCommandSeq = 1;
export const postPaneCommand = (
	command: Omit<PaneCommand, 'seq'> & { seq?: never }
): void => {
	multiChatPaneCommands.set({ ...command, seq: nextPaneCommandSeq++ } as PaneCommand);
};

export const multiChatActive = derived(multiChatActiveRootId, (rootId) => Boolean(rootId));
