export interface PendingWorkRequestContext {
	selected_model_ids: string[];
	selected_model_items: Record<string, Record<string, any>>;
	tool_ids: string[];
	tool_servers: Record<string, any>[];
	filter_ids: string[];
	features: Record<string, any>;
	reasoning_effort_by_model: Record<string, string>;
	params: Record<string, any>;
	variables: Record<string, any>;
	background_tasks: Record<string, any>;
	session_id: string | null;
}

export interface PendingWorkMessageInput {
	id?: string | null;
	prompt: string;
	files: Record<string, any>[];
	request_context?: PendingWorkRequestContext;
	status?: string | null;
}

export interface PendingWorkItem {
	id: string;
	status: string;
	prompt: string;
	files: Record<string, any>[];
	created_at?: string | null;
	updated_at?: string | null;
	last_error?: string | null;
	attempt_count?: number;
	sort_index?: number;
}

export interface PendingWorkState {
	chat_id: string;
	version: number;
	updated_at?: string | null;
	pending_steer: PendingWorkItem | null;
	queued_prompts: PendingWorkItem[];
}

export const emptyPendingWorkState = (chatId = ''): PendingWorkState => ({
	chat_id: chatId,
	version: 0,
	updated_at: null,
	pending_steer: null,
	queued_prompts: []
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

	return await res.json();
};

export const getChatPendingWork = async (
	token: string,
	chatId: string
): Promise<PendingWorkState> => {
	try {
		return await authedJsonFetch(token, `/api/v1/chats/${chatId}/pending-work`, {
			method: 'GET'
		});
	} catch (error) {
		console.warn('[chatPendingWork] Failed to fetch pending work:', error);
		return emptyPendingWorkState(chatId);
	}
};

export const replacePendingSteer = async (
	token: string,
	chatId: string,
	input: PendingWorkMessageInput
): Promise<PendingWorkState> =>
	authedJsonFetch(token, `/api/v1/chats/${chatId}/pending-steer`, {
		method: 'PUT',
		body: JSON.stringify(input)
	});

export const updatePendingSteer = async (
	token: string,
	chatId: string,
	input: PendingWorkMessageInput
): Promise<PendingWorkState> =>
	authedJsonFetch(token, `/api/v1/chats/${chatId}/pending-steer`, {
		method: 'PATCH',
		body: JSON.stringify(input)
	});

export const deletePendingSteer = async (
	token: string,
	chatId: string,
	itemId?: string | null
): Promise<PendingWorkState> =>
	authedJsonFetch(
		token,
		`/api/v1/chats/${chatId}/pending-steer${itemId ? `?item_id=${encodeURIComponent(itemId)}` : ''}`,
		{
			method: 'DELETE'
		}
	);

export const appendQueuedPrompt = async (
	token: string,
	chatId: string,
	input: PendingWorkMessageInput
): Promise<PendingWorkState> =>
	authedJsonFetch(token, `/api/v1/chats/${chatId}/queued-prompts`, {
		method: 'POST',
		body: JSON.stringify(input)
	});

export const updateQueuedPrompt = async (
	token: string,
	chatId: string,
	itemId: string,
	input: PendingWorkMessageInput
): Promise<PendingWorkState> =>
	authedJsonFetch(token, `/api/v1/chats/${chatId}/queued-prompts/${encodeURIComponent(itemId)}`, {
		method: 'PATCH',
		body: JSON.stringify(input)
	});

export const deleteQueuedPrompt = async (
	token: string,
	chatId: string,
	itemId: string
): Promise<PendingWorkState> =>
	authedJsonFetch(token, `/api/v1/chats/${chatId}/queued-prompts/${encodeURIComponent(itemId)}`, {
		method: 'DELETE'
	});
