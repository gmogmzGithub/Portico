/**
 * Chat Message Search API Client
 * PORTICO PATCH: Message-level search across conversations
 */

export interface MessageMatch {
	message_id: string;
	role: string;
	snippet: string;
	timestamp: number;
}

export interface ChatMessageSearchResult {
	chat_id: string;
	title: string;
	title_html: string;
	updated_at: number;
	model_id?: string | null;
	title_matched: boolean;
	match_count: number;
	matches: MessageMatch[];
}

export interface ChatSearchIndexStatus {
	state: 'ready' | 'building' | 'stale' | 'error';
	partial: boolean;
	indexed_chats: number;
	total_chats: number;
	indexed_messages: number;
	last_error?: string | null;
}

export interface MessageSearchResponse {
	results: ChatMessageSearchResult[];
	has_more: boolean;
	next_cursor: string | null;
	index_status: ChatSearchIndexStatus;
	regex_budget_exhausted: boolean;
}

export interface SearchOptions {
	text: string;
	cursor?: string;
	size?: number;
	role?: string;
	updated_since?: number;
	case_sensitive?: boolean;
	regex?: boolean;
}

export class ChatSearchRequestError extends Error {
	status?: number;

	constructor(message: string, options: { status?: number } = {}) {
		super(message);
		this.name = 'ChatSearchRequestError';
		this.status = options.status;
	}
}

export async function searchChatMessages(
	token: string,
	options: SearchOptions
): Promise<MessageSearchResponse> {
	const params = new URLSearchParams();
	params.set('text', options.text);
	if (options.cursor) params.set('cursor', options.cursor);
	if (options.size) params.set('size', String(options.size));
	if (options.role) params.set('role', options.role);
	if (options.updated_since) params.set('updated_since', String(options.updated_since));
	if (options.case_sensitive) params.set('case_sensitive', 'true');
	if (options.regex) params.set('regex', 'true');

	const res = await fetch(`/api/v1/chats/search/messages?${params.toString()}`, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		}
	});

	if (!res.ok) {
		let message = `Message search failed with status ${res.status}`;
		try {
			const payload = await res.json();
			if (typeof payload?.detail === 'string' && payload.detail.trim()) {
				message = payload.detail.trim();
			}
		} catch {
			try {
				const fallbackText = await res.text();
				if (fallbackText.trim()) {
					message = fallbackText.trim();
				}
			} catch {
				// Ignore secondary parsing failures.
			}
		}

		throw new ChatSearchRequestError(message, { status: res.status });
	}

	return await res.json();
}
