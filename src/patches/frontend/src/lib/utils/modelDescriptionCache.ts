import { marked } from 'marked';

import { sanitizeResponseContent } from '$lib/utils';

const modelDescriptionHtmlCache = new Map<string, string>();
const MAX_CACHED_MODEL_DESCRIPTIONS = 512;

const evictOldestModelDescription = () => {
	const oldestKey = modelDescriptionHtmlCache.keys().next().value as string | undefined;
	if (!oldestKey) {
		return;
	}

	modelDescriptionHtmlCache.delete(oldestKey);
};

export const getModelDescriptionHtml = (description: string): string => {
	const normalizedDescription = String(description ?? '').trim();
	if (!normalizedDescription) {
		return '';
	}

	const cachedDescriptionHtml = modelDescriptionHtmlCache.get(normalizedDescription);
	if (cachedDescriptionHtml) {
		return cachedDescriptionHtml;
	}

	const parsedDescriptionHtml = marked.parse(
		sanitizeResponseContent(normalizedDescription).replaceAll('\n', '<br>')
	) as string;

	if (modelDescriptionHtmlCache.size >= MAX_CACHED_MODEL_DESCRIPTIONS) {
		evictOldestModelDescription();
	}

	modelDescriptionHtmlCache.set(normalizedDescription, parsedDescriptionHtml);
	return parsedDescriptionHtml;
};
