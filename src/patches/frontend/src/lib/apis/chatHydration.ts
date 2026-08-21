export interface SubagentDescendantsResponse {
	chat_ids: string[];
	truncated: boolean;
	tool_calls?: Record<
		string,
		{
			chat_id: string;
			tool_call_count: number | null;
			display_tokens: number | null;
		}
	>;
}

const authedGet = async <T>(
	token: string,
	url: string,
	signal?: AbortSignal
): Promise<T> => {
	const response = await fetch(url, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		},
		signal
	});

	if (!response.ok) {
		throw await response.json().catch(() => new Error(`HTTP ${response.status}`));
	}

	return (await response.json()) as T;
};

export const getChatHydrationById = async (
	token: string,
	chatId: string,
	signal?: AbortSignal
): Promise<Record<string, any>> =>
	authedGet<Record<string, any>>(
		token,
		`/api/v1/chats/${encodeURIComponent(chatId)}/hydrate`,
		signal
	);

export const getChatReconciliationById = async (
	token: string,
	chatId: string,
	signal?: AbortSignal
): Promise<Record<string, any>> =>
	authedGet<Record<string, any>>(
		token,
		`/api/v1/chats/${encodeURIComponent(chatId)}`,
		signal
	);

export const getSubagentDescendants = async (
	token: string,
	chatId: string,
	signal?: AbortSignal
): Promise<SubagentDescendantsResponse> =>
	authedGet<SubagentDescendantsResponse>(
		token,
		`/api/v1/chats/${encodeURIComponent(chatId)}/subagent-descendants`,
		signal
	);
