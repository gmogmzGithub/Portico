/**
 * Chat State API Client
 *
 * Provides functions to persist and retrieve chat session state
 * (context usage, reasoning effort) from the chat-state-api service.
 *
 * This enables state persistence for both browser-based sessions
 * and headless subagent sessions.
 */

import {
	primaryReasoningEffortFromByModel,
	sanitizeReasoningEffortByModel
} from '$lib/utils/chatReasoningState';

const CHAT_STATE_API_BASE = 'http://localhost:3835';

function buildChatStateAuthHeaders(extraHeaders: Record<string, string> = {}) {
	const token = localStorage?.token;
	return {
		...extraHeaders,
		...(token ? { Authorization: `Bearer ${token}` } : {})
	};
}

export interface ChatState {
	chat_id: string;
	context_tokens: number;
	max_context_tokens: number;
	reasoning_effort?: string;  // Legacy: single value for all models
	reasoning_effort_by_model?: Record<string, string>;  // New: per-model reasoning effort
	fast_mode?: boolean;  // Per-chat lightning (OpenAI fast mode) toggle
	model_name?: string;
	last_updated: string;
	created_at: string;
}

export interface ChatStateInput {
	context_tokens?: number;
	max_context_tokens?: number;
	reasoning_effort?: string;  // Legacy: single value for all models
	reasoning_effort_by_model?: Record<string, string>;  // New: per-model reasoning effort
	fast_mode?: boolean;  // Per-chat lightning (OpenAI fast mode) toggle
	model_name?: string;
}

/**
 * Fetch persisted chat state by chat ID.
 *
 * @param chatId - The chat ID to fetch state for
 * @returns The chat state or null if not found
 */
export async function getChatState(chatId: string): Promise<ChatState | null> {
	try {
		const response = await fetch(
			`${CHAT_STATE_API_BASE}/api/v1/chat-state/${encodeURIComponent(chatId)}`,
			{
				headers: buildChatStateAuthHeaders()
			}
		);

		if (response.status === 404) {
			return null;
		}

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		return await response.json();
	} catch (error) {
		console.warn('[chatState] Failed to fetch chat state:', error);
		return null;
	}
}

/**
 * Save (create or update) chat state.
 *
 * @param chatId - The chat ID to save state for
 * @param state - The state to persist
 * @returns The saved chat state or null on error
 */
export async function saveChatState(
	chatId: string,
	state: ChatStateInput
): Promise<ChatState | null> {
	try {
		const reasoningEffortByModel = sanitizeReasoningEffortByModel(
			state.reasoning_effort_by_model ?? null
		);
		const response = await fetch(
			`${CHAT_STATE_API_BASE}/api/v1/chat-state/${encodeURIComponent(chatId)}`,
			{
				method: 'PUT',
				headers: buildChatStateAuthHeaders({ 'Content-Type': 'application/json' }),
				body: JSON.stringify({
					context_tokens: state.context_tokens ?? 0,
					max_context_tokens: state.max_context_tokens ?? 128000,
					// Keep the legacy field aligned with the canonical per-model map.
					reasoning_effort:
						state.reasoning_effort ??
						primaryReasoningEffortFromByModel(reasoningEffortByModel) ??
						null,
					reasoning_effort_by_model: reasoningEffortByModel,
					// Omit fast_mode unless explicitly boolean — the backend only
					// $sets the field when present, so omission preserves the
					// stored toggle instead of clobbering it.
					...(typeof state.fast_mode === 'boolean' ? { fast_mode: state.fast_mode } : {}),
					model_name: state.model_name ?? null
				})
			}
		);

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		return await response.json();
	} catch (error) {
		console.warn('[chatState] Failed to save chat state:', error);
		return null;
	}
}

/**
 * Delete chat state by chat ID.
 *
 * @param chatId - The chat ID to delete state for
 * @returns True if deleted, false otherwise
 */
export async function deleteChatState(chatId: string): Promise<boolean> {
	try {
		const response = await fetch(
			`${CHAT_STATE_API_BASE}/api/v1/chat-state/${encodeURIComponent(chatId)}`,
			{
				method: 'DELETE',
				headers: buildChatStateAuthHeaders()
			}
		);

		return response.ok || response.status === 404;
	} catch (error) {
		console.warn('[chatState] Failed to delete chat state:', error);
		return false;
	}
}
