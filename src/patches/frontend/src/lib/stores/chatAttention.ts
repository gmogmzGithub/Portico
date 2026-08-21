// PORTICO PATCH (Round 4 / Issue 7b — sidebar attention store).
//
// Centralised Svelte store for the per-chat amber-dot map. Keeping
// this in its own file (instead of inlining into Sidebar.svelte)
// means the same store can be read from any nested component
// (ChatItem, FolderItem) without prop-drilling, and so tests can
// assert the public refresh contract without booting the entire
// Sidebar.
//
// Refresh policy:
//   * Sidebar bootstraps the store on mount (cold load).
//   * Sidebar refreshes on every chat-list reload (whenever
//     ``initChatList()`` runs — covers the chip-resolution path
//     because resolving a chip causes the chat content to update,
//     which the sidebar already reacts to).
//   * The chip-decision handler in ``MessageInput.svelte`` may also
//     call ``refreshChatAttention()`` directly so the dot vanishes
//     immediately on the chat the user just resolved, without
//     waiting for a chat-list reload.

import { writable } from 'svelte/store';
import { getChatAttention, indexAttentionItems } from '$lib/apis/chatAttention';

/**
 * Map<chat_id, reason>. ``null`` means "not yet loaded" so the
 * sidebar can render rows without dots until the first fetch
 * resolves (avoids the brief flash where every row has no dot then
 * suddenly some get one).
 */
export const chatAttention = writable<Map<string, string> | null>(null);

let inFlight: Promise<void> | null = null;

/**
 * Refresh the store from the backend. Coalesces concurrent calls so
 * a chat-list reload + a chip-resolution arriving in the same tick
 * only triggers one fetch. Soft-fails (logs + leaves the previous
 * value untouched) if the network call fails.
 */
export const refreshChatAttention = async (token: string | null | undefined): Promise<void> => {
	if (!token) {
		chatAttention.set(new Map());
		return;
	}
	if (inFlight) {
		return inFlight;
	}
	inFlight = (async () => {
		try {
			const res = await getChatAttention(token);
			chatAttention.set(indexAttentionItems(res.items));
		} catch (error) {
			console.warn('[chatAttention store] refresh failed:', error);
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
};

/**
 * Optimistic clear — used by the chip-resolution handler to drop the
 * dot from a single chat as soon as the user clicks an option,
 * before the next backend refresh comes back. Avoids a stale dot
 * flicker. The next ``refreshChatAttention()`` will reconcile.
 */
export const clearChatAttentionLocally = (chatId: string): void => {
	chatAttention.update((current) => {
		if (!current || !current.has(chatId)) {
			return current;
		}
		const next = new Map(current);
		next.delete(chatId);
		return next;
	});
};
