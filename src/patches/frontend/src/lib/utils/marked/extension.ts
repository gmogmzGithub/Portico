// PATCHED_MARKER_v2 - Multi-line regex fix for details/summary parsing
// This patch fixes the regex to use [\s\S]*? for proper multi-line content matching

// Helper function to find matching closing tag
function findMatchingClosingTag(src: string, openTag: string, closeTag: string): number {
	let depth = 1;
	let index = openTag.length;
	while (depth > 0 && index < src.length) {
		if (src.startsWith(openTag, index)) {
			depth++;
		} else if (src.startsWith(closeTag, index)) {
			depth--;
		}
		if (depth > 0) {
			index++;
		}
	}
	return depth === 0 ? index + closeTag.length : -1;
}

// Function to parse attributes from tag
function parseAttributes(tag: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	// Allow hyphens in attribute names (data-*, aria-*, etc.)
	const attrRegex = /([^\s=]+)\s*=\s*"((?:\\.|[^"])*)"/g;
	let match: RegExpExecArray | null;
	while ((match = attrRegex.exec(tag)) !== null) {
		attributes[match[1]] = match[2];
	}
	return attributes;
}

function extractDetailsOpenTag(src: string): { tag: string; length: number } | null {
	if (!src.toLowerCase().startsWith('<details')) {
		return null;
	}

	let index = '<details'.length;
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
			if (char === '"' || char === '\'') {
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
}

function detailsTokenizer(src: string) {
	const leadingWhitespaceMatch = src.match(/^\s*/);
	const leadingWhitespace = leadingWhitespaceMatch ? leadingWhitespaceMatch[0] : '';
	const workingSrc = src.slice(leadingWhitespace.length);

	const summaryRegex = /^<summary>([\s\S]*?)<\/summary>\s*(?:\r?\n)?/i;
	const detailsIndex = workingSrc.toLowerCase().indexOf('<details');
	if (detailsIndex === -1) {
		return;
	}

	const prefix = workingSrc.slice(0, detailsIndex);
	const detailsSrc = workingSrc.slice(detailsIndex);
	const openTagInfo = extractDetailsOpenTag(detailsSrc);

	if (!openTagInfo) {
		return;
	}

	const closeTag = '</details>';
	const endIndexInDetails = findMatchingClosingTag(detailsSrc, '<details', closeTag);

	if (endIndexInDetails === -1) {
		return;
	}

	const fullMatch =
		leadingWhitespace + workingSrc.slice(0, detailsIndex) + detailsSrc.slice(0, endIndexInDetails);
	const detailsTag = openTagInfo.tag;
	const attributes = parseAttributes(detailsTag);

	const contentStart = openTagInfo.length;
	const contentEnd = endIndexInDetails - closeTag.length;
	let content = detailsSrc.slice(contentStart, contentEnd).trim();
	let summary = '';

	const summaryMatch = summaryRegex.exec(content);

	if (summaryMatch) {
		summary = summaryMatch[1].trim();
		content = content.slice(summaryMatch[0].length).trim();
	}

	const leadingTextContent = leadingWhitespace + prefix;

	return {
		type: 'details',
		raw: fullMatch,
		summary: summary,
		text: content,
		attributes: attributes,
		leadingText: leadingTextContent.length > 0 ? leadingTextContent : undefined
	};
}

function detailsRenderer(token: {
	type: string;
	summary?: string;
	text?: string;
	attributes?: Record<string, string>;
	leadingText?: string;
}) {
	const attributesString = token.attributes
		? ' ' +
			Object.entries(token.attributes)
				.map(([key, value]) => `${key}="${value}"`)
				.join(' ')
		: '';

	const leadingText = token.leadingText ?? '';
	const separator = leadingText && !leadingText.endsWith('\n') ? '\n' : '';
	return `${leadingText}${separator}<details${attributesString}>
${token.summary ? `<summary>${token.summary}</summary>` : ''}
${token.text}
</details>`;
}

// Extension wrapper function
function detailsExtension() {
	return {
		name: 'details',
		level: 'block',
		start(src: string) {
			// PORTICO_PATCH: Fast-path — skip the regex search entirely when
			// there is no '<d' or '<D' in the remaining source.  This avoids
			// O(remaining_length) regex work at every block boundary, which
			// was a profiled hot-spot for long documents.
			if (src.indexOf('<d') === -1 && src.indexOf('<D') === -1) {
				return undefined;
			}
			const trimmedIndex = src.search(/<details/i);
			return trimmedIndex !== -1 ? trimmedIndex : undefined;
		},
		tokenizer: detailsTokenizer,
		renderer: detailsRenderer
	};
}

export default function (options = {}) {
	return {
		extensions: [detailsExtension()]
	};
}
