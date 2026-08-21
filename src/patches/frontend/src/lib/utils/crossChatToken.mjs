// Wire format for cross-chat provenance prefixes (built by the subagents
// server's cross_chat_prefix in subagents_cross_chat.rs — keep in sync):
//
//   [Message from another chat: [[xchat:<chat_id>|<display_name>|<model_name>|<model_id>|<agent|model>]]]
//
// The surrounding literal keeps the prompt self-describing for the model and
// preserves the "message from another chat" workflows-skill trigger; the
// token fields let the frontend render the whole prefix as a badge row.
// Fields are percent-escaped for the four grammar characters only.

export const XCHAT_PREFIX_LITERAL = '[Message from another chat: [[xchat:';

export const escapeXchatField = (value) =>
	String(value ?? '')
		.replaceAll('%', '%25')
		.replaceAll('|', '%7C')
		.replaceAll('[', '%5B')
		.replaceAll(']', '%5D');

// Inverse order: the grammar characters first, '%25' last, so escaped
// percent signs never re-trigger the other substitutions.
export const unescapeXchatField = (value) =>
	String(value ?? '')
		.replaceAll('%7C', '|')
		.replaceAll('%5B', '[')
		.replaceAll('%5D', ']')
		.replaceAll('%25', '%');

export const formatXchatPrefix = ({
	chatId,
	displayName,
	modelName = '',
	modelId = '',
	isAgent = false
}) =>
	`[Message from another chat: [[xchat:${escapeXchatField(chatId)}|${escapeXchatField(
		displayName
	)}|${escapeXchatField(modelName)}|${escapeXchatField(modelId)}|${isAgent ? 'agent' : 'model'}]]]`;

const XCHAT_TOKEN_PATTERN =
	/^\[Message from another chat: \[\[xchat:([^[\]|]*)\|([^[\]|]*)\|([^[\]|]*)\|([^[\]|]*)\|(agent|model)\]\]\]/;

/**
 * Parse a cross-chat prefix at the START of `src`. Returns null for legacy
 * plain prefixes and anything malformed — callers fall back to rendering the
 * original text.
 */
export const parseXchatPrefix = (src) => {
	const match = XCHAT_TOKEN_PATTERN.exec(String(src ?? ''));
	if (!match) {
		return null;
	}
	const [raw, chatId, displayName, modelName, modelId, kind] = match;
	const cleanChatId = unescapeXchatField(chatId).trim();
	const cleanDisplayName = unescapeXchatField(displayName).trim();
	if (!cleanChatId || !cleanDisplayName) {
		return null;
	}
	return {
		raw,
		chatId: cleanChatId,
		displayName: cleanDisplayName,
		modelName: unescapeXchatField(modelName).trim(),
		modelId: unescapeXchatField(modelId).trim(),
		isAgent: kind === 'agent'
	};
};
