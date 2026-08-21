const CODE_BLOCK_OR_CODESPAN_RE = /(```[\s\S]*?```|`[\s\S]*?`)/g;

const COMPLETE_LEGACY_REASONING_BLOCK_RE =
	/(^|\n)<(think|thinking|reason|reasoning|thought|Thought)>([\s\S]*?)<\/\2>/g;

const LEGACY_REASONING_RENDER_HINT_RE = /<(think|thinking|reason|reasoning|thought|Thought)>/;

export const EXTRA_REASONING_STREAMING_MARKERS = [
	/<thinking>/i,
	/<\/thinking>/i,
	/<reason>/i,
	/<\/reason>/i,
	/<reasoning>/i,
	/<\/reasoning>/i,
	/<thought>/i,
	/<\/thought>/i,
	/<Thought>/,
	/<\/Thought>/,
	/<\|begin_of_thought\|>/,
	/<\|end_of_thought\|>/,
	/◁think▷/,
	/◁\/think▷/
];

type ProtectedCodeRange = { start: number; end: number };

const getProtectedCodeRanges = (content: string): ProtectedCodeRange[] => {
	return Array.from(content.matchAll(CODE_BLOCK_OR_CODESPAN_RE), (match) => ({
		start: match.index,
		end: match.index + match[0].length
	}));
};

const isProtectedCodeOffset = (offset: number, ranges: ProtectedCodeRange[]): boolean => {
	return ranges.some(({ start, end }) => offset >= start && offset < end);
};

const normalizeLegacyReasoningSegment = (
	segment: string,
	protectedCodeRanges: ProtectedCodeRange[]
): string => {
	return segment.replace(
		COMPLETE_LEGACY_REASONING_BLOCK_RE,
		(match, prefix: string, tagName: string, body: string, offset: number) => {
			const openerOffset = offset + prefix.length;
			const closerOffset = offset + match.lastIndexOf(`</${tagName}>`);
			if (
				isProtectedCodeOffset(openerOffset, protectedCodeRanges) ||
				isProtectedCodeOffset(closerOffset, protectedCodeRanges)
			) {
				return match;
			}

			const trimmedBody = body.trim();
			if (!trimmedBody) {
				return '';
			}

			return `${prefix}<details type="reasoning" done="true">\n<summary>Thought</summary>\n${trimmedBody}\n</details>`;
		}
	);
};

export const normalizeLegacyReasoningMarkup = (content: string): string => {
	if (!content || !LEGACY_REASONING_RENDER_HINT_RE.test(content)) {
		return content;
	}

	// Protect tag examples whose opener or closer is actually code, but allow
	// genuine reasoning bodies to contain inline/fenced code of their own.
	return normalizeLegacyReasoningSegment(content, getProtectedCodeRanges(content));
};

// Reasoning details produced from legacy/leaked literal think markup carry no
// duration attribute and never streamed in this client, so a fabricated
// "Thought 0s" label is misleading — show a time only when one was measured.
export const shouldShowThoughtDuration = (
	attributes: Record<string, unknown> | null | undefined,
	trackedElapsedSeconds: number | null | undefined
): boolean => {
	const rawDuration = attributes?.duration;
	if (rawDuration !== undefined && rawDuration !== null && rawDuration !== 'None') {
		const parsed = parseInt(String(rawDuration), 10);
		if (Number.isFinite(parsed)) {
			return true;
		}
	}
	return typeof trackedElapsedSeconds === 'number' && trackedElapsedSeconds > 0;
};
