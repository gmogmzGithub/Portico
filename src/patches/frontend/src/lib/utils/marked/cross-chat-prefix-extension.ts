import { parseXchatPrefix, XCHAT_PREFIX_LITERAL } from '$lib/utils/crossChatToken.mjs';

// Renders the whole `[Message from another chat: [[xchat:...]]]` provenance
// prefix as one token so CrossChatPrefixToken.svelte can replace it with a
// badge row. Legacy plain prefixes deliberately do not match and keep
// rendering as ordinary text.
export function crossChatPrefixExtension() {
	return {
		name: 'crossChatPrefix',
		level: 'inline' as const,

		start(src: string) {
			return src.indexOf(XCHAT_PREFIX_LITERAL);
		},

		tokenizer(src: string) {
			if (!src.startsWith(XCHAT_PREFIX_LITERAL)) {
				return;
			}
			const parsed = parseXchatPrefix(src);
			if (!parsed) {
				return;
			}
			return {
				type: 'crossChatPrefix',
				raw: parsed.raw,
				chatId: parsed.chatId,
				displayName: parsed.displayName,
				modelName: parsed.modelName,
				modelId: parsed.modelId,
				isAgent: parsed.isAgent
			};
		},

		renderer(token: { raw: string }) {
			return token.raw;
		}
	};
}

export default function () {
	return {
		extensions: [crossChatPrefixExtension()]
	};
}
