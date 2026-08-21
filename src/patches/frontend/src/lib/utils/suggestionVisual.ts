export type SuggestionVisualKind =
	| 'welcome'
	| 'integrations'
	| 'meetings'
	| 'portico'
	| 'prompt';

type SuggestionPrompt = {
	content?: unknown;
	title?: unknown;
};

const normalizeSuggestionText = (prompt: SuggestionPrompt | null | undefined): string => {
	const title = Array.isArray(prompt?.title) ? prompt.title : [prompt?.title];

	return [prompt?.content, ...title]
		.filter((part): part is string => typeof part === 'string')
		.join(' ')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
};

/**
 * Adds presentation-only artwork to the suggestion cards. Matching semantic
 * phrases keeps configured/custom prompt ordering and click payloads intact.
 */
export const resolveSuggestionVisualKind = (
	prompt: SuggestionPrompt | null | undefined
): SuggestionVisualKind => {
	const text = normalizeSuggestionText(prompt);

	// Check the welcome intent before Portico because the canonical first-use
	// prompt includes the product name as part of its sentence.
	if (
		text.includes('first time') ||
		text.includes("i'm new here") ||
		text.includes('i am new here') ||
		text.includes('what can you do') ||
		text.includes('what are you able to do')
	) {
		return 'welcome';
	}

	if (
		text.includes('integration') ||
		text.includes('connector') ||
		text.includes('connect a new')
	) {
		return 'integrations';
	}

	if (
		text.includes('meeting') ||
		text.includes('calendar') ||
		text.includes('appointment') ||
		text.includes('schedule')
	) {
		return 'meetings';
	}

	if (text.includes('portico')) {
		return 'portico';
	}

	return 'prompt';
};
