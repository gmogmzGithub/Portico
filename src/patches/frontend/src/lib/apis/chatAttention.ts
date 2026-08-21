// PORTICO PATCH (Round 4 / Issue 7b — sidebar attention API client).
//
// Drives the amber dot rendered by ``TaskAttentionDot.svelte`` next to
// chat titles in the sidebar. Backed by ``GET /api/v1/utils/chat-attention``
// which returns one entry per chat the calling user owns AND that
// currently has a pending chip (tool-confirmation / clarification /
// future kinds). The endpoint is read-only and intentionally cheap so
// the sidebar can re-fetch on every chat-list refresh without backend
// cost.
//
// Threat-model invariants pinned by the backend:
//   * the route requires ``get_verified_user`` (auth header).
//   * chat ownership is cross-referenced server-side, so a forged
//     chat_id in the response would still have been filtered out.
//   * the response is intentionally minimal — only chat_id + reason —
//     so we never leak chip payloads to the sidebar layer.

export interface ChatAttentionItem {
	chat_id: string;
	reason: string;
}

export interface ChatAttentionResponse {
	items: ChatAttentionItem[];
}

export const emptyChatAttentionResponse = (): ChatAttentionResponse => ({
	items: []
});

const authedJsonFetch = async (
	token: string,
	url: string,
	options: RequestInit = {}
): Promise<any> => {
	const res = await fetch(url, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
			...(options.headers ?? {})
		}
	});
	if (!res.ok) {
		throw await res.json().catch(() => new Error(`HTTP ${res.status}`));
	}
	if (res.status === 204) {
		return null;
	}
	return await res.json();
};

/**
 * Fetch the per-chat attention map for the calling user. Soft-fails on
 * any error (network, auth, 5xx) by returning an empty payload — the
 * sidebar will simply not render dots, which is the safe default. We
 * never throw upward because the sidebar must keep rendering even if
 * this endpoint is briefly unavailable (e.g. backend restart).
 */
export const getChatAttention = async (token: string): Promise<ChatAttentionResponse> => {
	try {
		const res = await authedJsonFetch(token, '/api/v1/utils/chat-attention', { method: 'GET' });
		if (!res || !Array.isArray(res.items)) {
			return emptyChatAttentionResponse();
		}
		return { items: res.items };
	} catch (error) {
		console.warn('[chatAttention] failed to fetch attention map:', error);
		return emptyChatAttentionResponse();
	}
};

/**
 * Reduce the response into a Map<chat_id, reason> so callers (Sidebar
 * + ChatItem) can do O(1) lookups on each row render. Keeping the
 * shape here avoids re-implementing the same fold inline in the
 * Sidebar component.
 */
export const indexAttentionItems = (
	items: ChatAttentionItem[]
): Map<string, string> => {
	const out = new Map<string, string>();
	for (const item of items) {
		if (item && typeof item.chat_id === 'string' && item.chat_id.length > 0) {
			out.set(item.chat_id, typeof item.reason === 'string' ? item.reason : '');
		}
	}
	return out;
};
