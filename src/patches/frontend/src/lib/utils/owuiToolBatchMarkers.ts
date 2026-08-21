import type { Token } from 'marked';

export type DetailSegment =
	| { type: 'text'; content: string }
	| {
			type: 'details';
			attributes: Record<string, string>;
			summary: string;
			body: string;
			__owuiToolBlockIndex?: number;
			__owuiToolBlockTerminal?: boolean;
	  };

export type ToolBatchToken = Token & {
	attributes?: Record<string, unknown>;
	text?: string;
	__owuiToolBlockIndex?: number;
	__owuiToolBlockTerminal?: boolean;
	__owuiDetailsSegments?: DetailSegment[];
};

const DETAILS_OPEN_TAG = '<details';
const DETAILS_CLOSE_TAG = '</details>';

const findMatchingClosingTag = (src: string, openTag: string, closeTag: string): number => {
	let depth = 1;
	let index = openTag.length;

	while (depth > 0 && index < src.length) {
		if (src.startsWith(openTag, index)) {
			depth++;
			index += openTag.length;
			continue;
		}

		if (src.startsWith(closeTag, index)) {
			depth--;
			index += closeTag.length;
			continue;
		}

		index++;
	}

	return depth === 0 ? index : -1;
};

const parseAttributes = (tag: string): Record<string, string> => {
	const attributes: Record<string, string> = {};
	const attrRegex = /([^\s=]+)\s*=\s*"((?:\\.|[^"])*)"/g;
	let match: RegExpExecArray | null;

	while ((match = attrRegex.exec(tag)) !== null) {
		attributes[match[1]] = match[2];
	}

	return attributes;
};

const extractDetailsOpenTag = (src: string): { tag: string; length: number } | null => {
	if (!src.toLowerCase().startsWith(DETAILS_OPEN_TAG)) {
		return null;
	}

	let index = DETAILS_OPEN_TAG.length;
	let quote: string | null = null;

	while (index < src.length) {
		const char = src[index];

		if (quote) {
			if (char === '\\' && index + 1 < src.length) {
				index += 2;
				continue;
			}

			if (char === quote) {
				quote = null;
			}
		} else {
			if (char === '"' || char === "'") {
				quote = char;
			} else if (char === '>') {
				return {
					tag: src.slice(0, index + 1),
					length: index + 1
				};
			}
		}

		index++;
	}

	return null;
};

const parseDetailsBlock = (html: string) => {
	const trimmed = html.trimStart();
	if (!trimmed.toLowerCase().startsWith(DETAILS_OPEN_TAG)) {
		return null;
	}

	const summaryRegex = /^<summary>([\s\S]*?)<\/summary>\s*(?:\r?\n)?/i;

	const openTagInfo = extractDetailsOpenTag(trimmed);
	if (!openTagInfo) {
		return null;
	}

	const endIndex = findMatchingClosingTag(trimmed, DETAILS_OPEN_TAG, DETAILS_CLOSE_TAG);
	if (endIndex === -1) {
		return null;
	}

	const detailsTag = openTagInfo.tag;
	const attributes = parseAttributes(detailsTag);
	const contentStart = openTagInfo.length;
	const contentEnd = endIndex - DETAILS_CLOSE_TAG.length;
	let body = trimmed.slice(contentStart, contentEnd).trim();
	let summary = '';

	const summaryMatch = summaryRegex.exec(body);
	if (summaryMatch) {
		summary = summaryMatch[1].trim();
		body = body.slice(summaryMatch[0].length).trim();
	}

	return {
		attributes,
		summary,
		body
	};
};

export const splitDetailsHtml = (html: string): DetailSegment[] => {
	const segments: DetailSegment[] = [];
	let remaining = html;

	while (remaining.length > 0) {
		const detailsIndex = remaining.toLowerCase().indexOf(DETAILS_OPEN_TAG);

		if (detailsIndex === -1) {
			if (remaining.trim().length > 0) {
				segments.push({ type: 'text', content: remaining });
			}
			break;
		}

		const before = remaining.slice(0, detailsIndex);
		if (before.trim().length > 0) {
			segments.push({ type: 'text', content: before });
		}

		const detailSlice = remaining.slice(detailsIndex);
		const endIndex = findMatchingClosingTag(detailSlice, DETAILS_OPEN_TAG, DETAILS_CLOSE_TAG);
		if (endIndex === -1) {
			segments.push({ type: 'text', content: detailSlice });
			break;
		}

		const rawDetails = detailSlice.slice(0, endIndex);
		const parsed = parseDetailsBlock(rawDetails);

		if (parsed) {
			segments.push({
				type: 'details',
				attributes: parsed.attributes,
				summary: parsed.summary,
				body: parsed.body
			});
		} else {
			segments.push({ type: 'text', content: rawDetails });
		}

		remaining = detailSlice.slice(endIndex);
	}

	return segments;
};

const normalizeDetailsType = (detailsType: unknown): string =>
	String(detailsType ?? '')
		.trim()
		.toLowerCase();

const isToolCallDetailsType = (detailsType: unknown): boolean =>
	normalizeDetailsType(detailsType) === 'tool_calls';

const isWhitespaceTextSegment = (segment: DetailSegment): boolean =>
	segment.type === 'text' && segment.content.trim().length === 0;

const clearToolBatchMetadata = (token: ToolBatchToken) => {
	delete token.__owuiToolBlockIndex;
	delete token.__owuiToolBlockTerminal;
	delete token.__owuiDetailsSegments;
};

const clearToolBatchMetadataFromSegment = (segment: DetailSegment) => {
	if (segment.type !== 'details') {
		return;
	}

	delete segment.__owuiToolBlockIndex;
	delete segment.__owuiToolBlockTerminal;
};

type PendingToolCarrier =
	| { type: 'token'; target: ToolBatchToken }
	| { type: 'segment'; target: Extract<DetailSegment, { type: 'details' }> };

export const annotateToolBatchTokens = (tokenList: Token[]): Token[] => {
	let nextToolBlockIndex = 0;
	let activeToolBlockIndex: number | null = null;
	let pendingToolCarrier: PendingToolCarrier | null = null;

	const finalizePendingToolBatch = () => {
		if (pendingToolCarrier?.type === 'token') {
			pendingToolCarrier.target.__owuiToolBlockTerminal = true;
		} else if (pendingToolCarrier?.type === 'segment') {
			pendingToolCarrier.target.__owuiToolBlockTerminal = true;
		}

		pendingToolCarrier = null;
		activeToolBlockIndex = null;
	};

	const assignToolBatchToToken = (token: ToolBatchToken) => {
		if (activeToolBlockIndex === null) {
			activeToolBlockIndex = nextToolBlockIndex++;
		}

		token.__owuiToolBlockIndex = activeToolBlockIndex;
		token.__owuiToolBlockTerminal = false;
		pendingToolCarrier = { type: 'token', target: token };
	};

	const assignToolBatchToSegment = (segment: Extract<DetailSegment, { type: 'details' }>) => {
		if (activeToolBlockIndex === null) {
			activeToolBlockIndex = nextToolBlockIndex++;
		}

		segment.__owuiToolBlockIndex = activeToolBlockIndex;
		segment.__owuiToolBlockTerminal = false;
		pendingToolCarrier = { type: 'segment', target: segment };
	};

	for (const rawToken of tokenList) {
		const token = rawToken as ToolBatchToken;
		clearToolBatchMetadata(token);

		if (token.type === 'space') {
			continue;
		}

		if (token.type === 'details') {
			if (isToolCallDetailsType(token.attributes?.type)) {
				assignToolBatchToToken(token);
			} else {
				finalizePendingToolBatch();
			}
			continue;
		}

		if (token.type === 'html') {
			const rawHtml = token.text ?? '';
			const htmlSegments = splitDetailsHtml(rawHtml);
			if (htmlSegments.length === 0) {
				if (rawHtml.trim().length === 0) {
					continue;
				}
				finalizePendingToolBatch();
				continue;
			}

			for (const segment of htmlSegments) {
				clearToolBatchMetadataFromSegment(segment);

				if (segment.type === 'details' && isToolCallDetailsType(segment.attributes?.type)) {
					assignToolBatchToSegment(segment);
					continue;
				}

				if (isWhitespaceTextSegment(segment)) {
					continue;
				}

				finalizePendingToolBatch();
			}

			token.__owuiDetailsSegments = htmlSegments;
			continue;
		}

		finalizePendingToolBatch();
	}

	finalizePendingToolBatch();
	return tokenList;
};
