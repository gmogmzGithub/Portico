<script lang="ts">
	// PORTICO_PATCH: Incremental markdown rendering for streaming performance.
	//
	// Problem: upstream Markdown.svelte re-lexes the ENTIRE message content on
	// every streaming commit and produces all-new token objects, causing Svelte
	// to destroy and recreate every DOM fragment in the {#each} block — O(n) per
	// commit, which grows to 200ms+ at 80K chars.
	//
	// Fix: two optimisations layered together:
	//   1. Incremental lexing — during streaming, keep a stable prefix of tokens
	//      that haven't changed and only run marked.lexer() on the growing tail
	//      (~500 chars).  This makes the lexer cost O(delta).
	//   2. Token reference reuse — compare fresh tokens with previous ones by
	//      type+raw, and substitute the old object reference when they match.
	//      Svelte's keyed {#each} sees the same reference and skips the DOM diff
	//      for that item.  This makes DOM work O(delta).
	//
	// Together the two changes bring per-commit cost from ~200ms to ~7ms for an
	// 80K-char message, well within a single 16ms frame.

	import { Marked, type Token } from 'marked';
	import { replaceTokens, processResponseContent } from '$lib/utils';
	import { user } from '$lib/stores';

	import markedExtension from '$lib/utils/marked/extension';
	import markedKatexExtension from '$lib/utils/marked/katex-extension';
	import { disableSingleTilde } from '$lib/utils/marked/strikethrough-extension';
	import { mentionExtension } from '$lib/utils/marked/mention-extension';

	import MarkdownTokens from './Markdown/MarkdownTokens.svelte';
	import footnoteExtension from '$lib/utils/marked/footnote-extension';
	import citationExtension, {
		areCitationIdsResolvable,
		getCitationSourceKey
	} from '$lib/utils/marked/citation-extension';
	import { crossChatPrefixExtension } from '$lib/utils/marked/cross-chat-prefix-extension';
	import { annotateToolBatchTokens } from '$lib/utils/owuiToolBatchMarkers';

	export let id = '';
	export let content;
	export let done = true;
	export let messageStopReason = null;
	export let model = null;
	export let save = false;
	export let preview = false;
	export let renderDisplayFilesInline = true;
	export let debugMarkersAfterToolBlockIndex: Record<number, any[]> = {};
	export let openDebugRequestModal: (requestId: string) => void = () => {};

	export let paragraphTag = 'p';
	export let editCodeBlock = true;
	export let topPadding = false;

	export let sourceIds = [];

	export let onSave = () => {};
	export let onUpdate = () => {};

	export let onPreview = () => {};

	export let onSourceClick = () => {};
	export let onTaskClick = () => {};
	export let onStopResponse = () => {};

	let tokens: Token[] = [];
	let citationSourceKey = '';

	// ── marked configuration (unchanged from upstream) ──────────────────
	const options = {
		throwOnError: false,
		breaks: true
	};

	const markdownParser = new Marked(options);

	markdownParser.use(markedKatexExtension(options));
	markdownParser.use(markedExtension(options));
	markdownParser.use(
		citationExtension({
			shouldTokenize: (ids) => areCitationIdsResolvable(sourceIds, ids)
		})
	);
	markdownParser.use(footnoteExtension(options));
	markdownParser.use(disableSingleTilde);
	markdownParser.use({
		extensions: [mentionExtension({ triggerChar: '@' }), mentionExtension({ triggerChar: '#' })]
	});
	markdownParser.use({ extensions: [crossChatPrefixExtension()] });

	const lexMarkdown = (raw: string): Token[] => markdownParser.lexer(raw);

	// ── Incremental rendering state ─────────────────────────────────────
	// Declared as a `const` object so Svelte's reactivity does NOT track
	// its properties — reads/writes inside $: won't create a dependency
	// cycle that would cause infinite re-evaluations.
	const _inc: {
		prevTokens: Token[];
		prevProcessed: string;
		lastId: string;
		lastCitationSourceKey: string;
		nextTokenKey: number;
	} = {
		prevTokens: [],
		prevProcessed: '',
		lastId: '',
		lastCitationSourceKey: '',
		nextTokenKey: 1
	};

	const resetIncrementalState = (messageId: string, sourceKey: string) => {
		_inc.prevTokens = [];
		_inc.prevProcessed = '';
		_inc.lastId = messageId;
		_inc.lastCitationSourceKey = sourceKey;
		_inc.nextTokenKey = 1;
	};

	const PARAGRAPH_LIKE_STREAMING_TYPES = new Set(['paragraph', 'text', 'space']);

	const isLikelyMutableTailToken = (token: Token): boolean => {
		const raw =
			(token.raw ?? ((token as Token & { text?: string }).text ?? '')) as string;
		if (!raw) {
			return true;
		}

		const normalizedRaw = raw.toLowerCase();

		// Details/tool/reasoning blocks can rebalance late; keep them in the
		// re-lex tail until we have more surrounding context.
		if (token.type === 'details') {
			return true;
		}
		if (token.type === 'html' && normalizedRaw.includes('<details') && !normalizedRaw.includes('</details>')) {
			return true;
		}

		// Paragraph-like blocks that do not end with a blank line may still
		// absorb subsequent lines on the next incremental parse.
		if (PARAGRAPH_LIKE_STREAMING_TYPES.has(token.type)) {
			return !raw.endsWith('\n\n');
		}

		// Non-newline terminated tails are generally still "open".
		return !raw.endsWith('\n') && !raw.endsWith('\r\n');
	};

	/**
	 * Build a stable prefix from the previous token list.
	 *
	 * We always keep at least the final token in the mutable tail, and we may
	 * peel back additional trailing tokens that are likely to reflow during
	 * append-only streaming (e.g., paragraph/details tails).
	 *
	 * Returns { stableTokens, rawLength } where rawLength is the number of
	 * characters in the processed source string that the stable tokens cover.
	 */
	const getStablePrefix = (
		prevTokens: Token[]
	): { stableTokens: Token[]; rawLength: number } => {
		let count = Math.max(0, prevTokens.length - 1);
		while (count > 0 && isLikelyMutableTailToken(prevTokens[count - 1])) {
			count -= 1;
		}

		let rawLength = 0;
		for (let i = 0; i < count; i++) {
			rawLength += (prevTokens[i].raw ?? '').length;
		}
		return { stableTokens: prevTokens.slice(0, count), rawLength };
	};

	/**
	 * Walk two token arrays from the start and reuse the *previous* object
	 * reference wherever the token hasn't changed (same type + identical
	 * raw source text).  Stable object references + stable token keys keep
	 * unchanged token subtrees mounted and avoid expensive create_fragment_from_html
	 * call for the corresponding DOM subtree.
	 */
	const reuseStableTokenRefs = (
		fresh: Token[],
		prev: Token[]
	): { tokens: Token[]; reusedCount: number } => {
		if (!prev.length) {
			return { tokens: fresh, reusedCount: 0 };
		}

		const result: Token[] = new Array(fresh.length);
		let reuseCount = 0;
		const limit = Math.min(fresh.length, prev.length);

		while (
			reuseCount < limit &&
			fresh[reuseCount].type === prev[reuseCount].type &&
			fresh[reuseCount].raw === prev[reuseCount].raw
		) {
			result[reuseCount] = prev[reuseCount]; // ← same reference → Svelte skips DOM
			reuseCount++;
		}

		for (let i = reuseCount; i < fresh.length; i++) {
			result[i] = fresh[i];
		}

		return { tokens: result, reusedCount: reuseCount };
	};

	const assignStableTokenKeys = (
		fresh: Token[],
		prev: Token[],
		prefixReuseCount: number
	): Token[] => {
		const getBucketKey = (token: Token): string => {
			if (token.type === 'details') {
				const detailsToken = token as Token & {
					attributes?: Record<string, unknown>;
					summary?: string;
				};
				const detailsType = String(detailsToken.attributes?.type ?? '')
					.trim()
					.toLowerCase();
				const detailsId = String(
					detailsToken.attributes?.id ??
						detailsToken.attributes?.name ??
						detailsToken.attributes?.started_at ??
						''
				).trim();
				if (detailsType || detailsId) {
					// Keep a stable component identity for live-updating details
					// blocks (reasoning/tool calls), even when raw text mutates.
					return `details:${detailsType}:${detailsId}`;
				}
			}

			const raw =
				(token.raw ?? ((token as Token & { text?: string }).text ?? '')) as string;
			return `${token.type}:${raw}`;
		};

		const keyBuckets = new Map<string, number[]>();
		for (let i = prefixReuseCount; i < prev.length; i++) {
			const prevToken = prev[i] as Token & { __streamKey?: number };
			const prevKey = prevToken.__streamKey;
			if (typeof prevKey !== 'number') continue;
			const bucketKey = getBucketKey(prevToken);
			const bucket = keyBuckets.get(bucketKey);
			if (bucket) {
				bucket.push(prevKey);
			} else {
				keyBuckets.set(bucketKey, [prevKey]);
			}
		}

		for (let i = 0; i < fresh.length; i++) {
			const token = fresh[i] as Token & { __streamKey?: number };
			if (typeof token.__streamKey === 'number') continue;
			const bucketKey = getBucketKey(token);
			const bucket = keyBuckets.get(bucketKey);
			if (bucket && bucket.length > 0) {
				token.__streamKey = bucket.shift() as number;
			} else {
				token.__streamKey = _inc.nextTokenKey++;
			}
		}

		return fresh;
	};

	// ── Reactive token computation ──────────────────────────────────────
	$: (() => {
		const nextCitationSourceKey = getCitationSourceKey(sourceIds);
		citationSourceKey = nextCitationSourceKey;

		// Reset incremental state when the message id changes (different message).
		if (id !== _inc.lastId || nextCitationSourceKey !== _inc.lastCitationSourceKey) {
			resetIncrementalState(id, nextCitationSourceKey);
		}

		if (content) {
			const processed = replaceTokens(
				processResponseContent(content),
				model?.name,
				$user?.name
			);
			const isStreamingGrowth = !done && processed.length > _inc.prevProcessed.length;

			let freshTokens: Token[];

			// ── Incremental path (streaming) ────────────────────────────
			// Conditions: still streaming (!done), we have prior state, and
			// the content only grew (append-only, which is the normal case).
			const canIncremental =
				!done &&
				_inc.prevTokens.length > 1 &&
				_inc.prevProcessed.length > 0 &&
				isStreamingGrowth;

			if (canIncremental) {
				const { stableTokens, rawLength } = getStablePrefix(_inc.prevTokens);

				// Safety: verify the processed-content prefix hasn't been
				// retroactively rewritten (very unlikely during normal streaming
				// but possible with message replacement events).
				if (
					rawLength > 0 &&
					rawLength <= processed.length &&
					processed.startsWith(_inc.prevProcessed.slice(0, rawLength))
				) {
					// Only lex the tail — O(delta) instead of O(n).
					const tail = processed.slice(rawLength);
					const tailTokens = tail ? lexMarkdown(tail) : [];
					freshTokens = stableTokens.concat(tailTokens);
				} else {
					// Prefix mismatch — fall back to full lex.
					freshTokens = lexMarkdown(processed);
				}
			} else {
				// Full lex: initial render, done=true, content shrank, etc.
				freshTokens = lexMarkdown(processed);
			}

			// Reuse old object references for tokens that haven't changed.
			// This is the key Svelte optimisation — unchanged references mean
			// the {#each} block skips create_fragment_from_html for those items.
			const { tokens: reusedTokens, reusedCount } = reuseStableTokenRefs(
				freshTokens,
				_inc.prevTokens
			);
			const allTokens = annotateToolBatchTokens(
				assignStableTokenKeys(reusedTokens, _inc.prevTokens, reusedCount)
			);

			// Keep every previously streamed token mounted so users can scroll
			// back and read the response while new content arrives. Stable token
			// references keep unchanged DOM subtrees from being reconstructed.
			tokens = allTokens;
			_inc.prevTokens = allTokens;
			_inc.prevProcessed = processed;
		} else {
			tokens = [];
			_inc.prevTokens = [];
			_inc.prevProcessed = '';
			_inc.lastCitationSourceKey = nextCitationSourceKey;
			_inc.nextTokenKey = 1;
		}
		})();
	</script>

<div class="markdown-stream-root">
	<div class="markdown-stream-live-window">
		<div class="markdown-stream-live-content">
			{#key id}
				<MarkdownTokens
					{id}
					{tokens}
					tokenizeMarkdown={lexMarkdown}
					tokenizeCacheKey={citationSourceKey}
					{done}
					{messageStopReason}
					{save}
					{preview}
					{renderDisplayFilesInline}
					{editCodeBlock}
					{topPadding}
					{debugMarkersAfterToolBlockIndex}
					{openDebugRequestModal}
					{sourceIds}
					{paragraphTag}
					{onSave}
					{onUpdate}
					{onPreview}
					{onSourceClick}
					{onTaskClick}
					{onStopResponse}
				/>
			{/key}
		</div>
	</div>
</div>

<style>
	.markdown-stream-root {
		position: relative;
	}

	.markdown-stream-live-window {
		position: relative;
		z-index: 0;
	}

	.markdown-stream-live-content {
		position: relative;
	}
</style>
