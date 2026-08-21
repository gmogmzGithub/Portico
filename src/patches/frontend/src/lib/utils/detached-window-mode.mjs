export const DETACHED_WINDOW_PARAM = 'detached-window';
export const DETACHED_WINDOW_MODE_SUBAGENT = 'subagent';
export const SUBAGENT_VIEW_PARAM = 'subagent-view';
export const SUBAGENT_VIEW_ENABLED = '1';

export function getDetachedWindowMode(searchParams) {
	if (!searchParams || typeof searchParams.get !== 'function') {
		return '';
	}

	return String(searchParams.get(DETACHED_WINDOW_PARAM) || '').trim().toLowerCase();
}

export function isDetachedSubagentView(searchParams) {
	return getDetachedWindowMode(searchParams) === DETACHED_WINDOW_MODE_SUBAGENT;
}

export function isDelegatedSubagentRoute(searchParams) {
	if (!searchParams || typeof searchParams.get !== 'function') {
		return false;
	}

	return (
		String(searchParams.get(SUBAGENT_VIEW_PARAM) || '').trim() === SUBAGENT_VIEW_ENABLED ||
		isDetachedSubagentView(searchParams)
	);
}

export function hasDelegatedSubagentMetadata(chatPayload) {
	if (!chatPayload || typeof chatPayload !== 'object') {
		return false;
	}

	const payload =
		chatPayload.chat && typeof chatPayload.chat === 'object' ? chatPayload.chat : chatPayload;
	const subagent = payload?.meta?.subagent;
	if (!subagent || typeof subagent !== 'object') {
		return false;
	}

	return ['parent_chat_id', 'root_parent_chat_id', 'parent_tool_call_id'].some(
		(key) => typeof subagent[key] === 'string' && subagent[key].trim().length > 0
	);
}
