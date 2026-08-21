export type CitationTokenizationPredicate = (ids: number[]) => boolean;

export type CitationExtensionOptions = {
	shouldTokenize?: CitationTokenizationPredicate;
};

export const resolveCitationSourceTitle = (sourceIds: unknown[] = [], id: number): string | null => {
	if (!Number.isInteger(id) || id < 1) {
		return null;
	}

	const rawTitle = sourceIds[id - 1];
	if (typeof rawTitle !== 'string') {
		return null;
	}

	const title = rawTitle.trim();
	if (!title || title.toUpperCase() === 'N/A') {
		return null;
	}

	return title;
};

export const areCitationIdsResolvable = (sourceIds: unknown[] = [], ids: number[] = []): boolean => {
	if (!Array.isArray(ids) || ids.length === 0) {
		return false;
	}

	return ids.every((id) => resolveCitationSourceTitle(sourceIds, id) !== null);
};

export const getCitationSourceKey = (sourceIds: unknown[] = []): string => {
	return sourceIds
		.map((value) => (typeof value === 'string' ? value.trim() : String(value ?? '')))
		.join('\u001f');
};

export function citationExtension(options: CitationExtensionOptions = {}) {
	const { shouldTokenize = () => true } = options;

	return {
		name: 'citation',
		level: 'inline' as const,

		start(src: string) {
			return src.search(/\[(\d[\d,\s]*)\]/);
		},

		tokenizer(src: string) {
			if (/^\[\^/.test(src)) return;

			const rule = /^(\[(?:\d[\d,\s]*)\])+/;
			const match = rule.exec(src);
			if (!match) return;

			const raw = match[0];
			const groupRegex = /\[([\d,\s]+)\]/g;
			const ids: number[] = [];
			let groupMatch: RegExpExecArray | null;

			while ((groupMatch = groupRegex.exec(raw))) {
				const parsed = groupMatch[1]
					.split(',')
					.map((value) => parseInt(value.trim(), 10))
					.filter((value) => !isNaN(value));

				ids.push(...parsed);
			}

			if (ids.length === 0 || !shouldTokenize(ids)) {
				return;
			}

			return {
				type: 'citation',
				raw,
				ids
			};
		},

		renderer(token: { ids: number[] }) {
			return token.ids.join(',');
		}
	};
}

export default function (options: CitationExtensionOptions = {}) {
	return {
		extensions: [citationExtension(options)]
	};
}
