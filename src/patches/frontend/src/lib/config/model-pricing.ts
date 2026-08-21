export interface ModelPricingSpec {
	key: string;
	displayName: string;
	inputPerMillion: number;
	outputPerMillion: number;
	cacheReadPerMillion?: number | null;
	cacheWritePerMillion?: number | null;
	highContext?: {
		thresholdPromptTokens: number;
		inputPerMillion: number;
		outputPerMillion: number;
		cacheReadPerMillion?: number | null;
		cacheWritePerMillion?: number | null;
	} | null;
	aliases: string[];
	matchers: RegExp[];
}

export interface PromptCacheMetricsInput {
	modelId?: string | null;
	modelName?: string | null;
	usage?: Record<string, unknown> | null;
	promptTokens?: number | string | null;
	completionTokens?: number | string | null;
	cachedTokens?: number | string | null;
	cacheReadInputTokens?: number | string | null;
	cacheCreationInputTokens?: number | string | null;
	cacheWriteInputTokens?: number | string | null;
	cost?: number | string | null;
	actualCost?: number | string | null;
}

export interface NormalizedPromptUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cachedTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	cacheWriteInputTokens: number;
	cost: number;
}

export interface PromptCacheMetrics {
	modelKey: string | null;
	modelName: string | null;
	supportsPricing: boolean;
	supportsCacheSavings: boolean;
	promptTokens: number;
	completionTokens: number;
	actualCost: number;
	effectiveActualCost: number;
	estimatedActualCost: number;
	estimatedCostWithoutCache: number;
	netCacheSavings: number;
	savingsRate: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	actualCacheReadCost: number;
	actualCacheWriteCost: number;
	uncachedEquivalentReadCost: number;
	uncachedEquivalentWriteCost: number;
	grossCacheReadSavings: number;
	cacheWritePremium: number;
}

const MODEL_PRICING: ModelPricingSpec[] = [
	{
		key: 'gpt-5.6-sol-pro',
		displayName: 'GPT-5.6 Sol Pro',
		inputPerMillion: 4.25,
		outputPerMillion: 25.5,
		cacheReadPerMillion: 0.425,
		cacheWritePerMillion: 5.3125,
		highContext: {
			thresholdPromptTokens: 272000,
			inputPerMillion: 8.5,
			outputPerMillion: 38.25,
			cacheReadPerMillion: 0.85,
			cacheWritePerMillion: 10.625
		},
		aliases: [
			'GPT-5.6 Sol Pro',
			'gpt-5.6-sol-pro',
			'openai/responses/gpt-5.6-sol-pro'
		],
		matchers: [/\bgpt 5 6 sol pro\b/]
	},
	{
		key: 'gpt-5.6-sol',
		displayName: 'GPT-5.6 Sol',
		inputPerMillion: 4.25,
		outputPerMillion: 25.5,
		cacheReadPerMillion: 0.425,
		cacheWritePerMillion: 5.3125,
		highContext: {
			thresholdPromptTokens: 272000,
			inputPerMillion: 8.5,
			outputPerMillion: 38.25,
			cacheReadPerMillion: 0.85,
			cacheWritePerMillion: 10.625
		},
		aliases: [
			'GPT-5.6 Sol',
			'gpt-5.6-sol',
			'openai/responses/gpt-5.6-sol',
			'portico-openai/gpt-5.6-sol'
		],
		matchers: [/\bgpt 5 6 sol\b/]
	},
	{
		key: 'gpt-5.6-terra',
		displayName: 'GPT-5.6 Terra',
		inputPerMillion: 2.125,
		outputPerMillion: 12.75,
		cacheReadPerMillion: 0.2125,
		cacheWritePerMillion: 2.65625,
		highContext: {
			thresholdPromptTokens: 272000,
			inputPerMillion: 4.25,
			outputPerMillion: 19.125,
			cacheReadPerMillion: 0.425,
			cacheWritePerMillion: 5.3125
		},
		aliases: [
			'GPT-5.6 Terra',
			'gpt-5.6-terra',
			'openai/responses/gpt-5.6-terra',
			'portico-openai/gpt-5.6-terra'
		],
		matchers: [/\bgpt 5 6 terra\b/]
	},
	{
		key: 'gpt-5.6-luna',
		displayName: 'GPT-5.6 Luna',
		inputPerMillion: 0.85,
		outputPerMillion: 5.1,
		cacheReadPerMillion: 0.085,
		cacheWritePerMillion: 1.0625,
		highContext: {
			thresholdPromptTokens: 272000,
			inputPerMillion: 1.7,
			outputPerMillion: 7.65,
			cacheReadPerMillion: 0.17,
			cacheWritePerMillion: 2.125
		},
		aliases: [
			'GPT-5.6 Luna',
			'gpt-5.6-luna',
			'openai/responses/gpt-5.6-luna',
			'portico-openai/gpt-5.6-luna'
		],
		matchers: [/\bgpt 5 6 luna\b/]
	},
	{
		key: 'gpt-5.5',
		displayName: 'GPT-5.5',
		inputPerMillion: 5,
		outputPerMillion: 30,
		cacheReadPerMillion: 0.5,
		aliases: ['GPT-5.5', 'gpt-5.5', 'openai/responses/gpt-5.5'],
		matchers: [/\bgpt 5 5\b/]
	},
	{
		key: 'gpt-5.4',
		displayName: 'GPT-5.4',
		inputPerMillion: 2.5,
		outputPerMillion: 15,
		cacheReadPerMillion: 0.25,
		aliases: ['GPT-5.4', 'gpt-5.4', 'openai/responses/gpt-5.4'],
		matchers: [/\bgpt 5 4\b/]
	},
	{
		key: 'gpt-5.4-pro',
		displayName: 'GPT-5.4 pro',
		inputPerMillion: 30,
		outputPerMillion: 180,
		aliases: ['GPT-5.4 pro', 'gpt-5.4-pro', 'openai/responses/gpt-5.4-pro'],
		matchers: [/\bgpt 5 4 pro\b/]
	},
	{
		key: 'gpt-4.1',
		displayName: 'GPT-4.1',
		inputPerMillion: 2,
		outputPerMillion: 8,
		cacheReadPerMillion: 0.5,
		aliases: ['GPT-4.1', 'gpt-4.1'],
		matchers: [/\bgpt 4 1\b/]
	},
	{
		key: 'gpt-4.1-mini',
		displayName: 'GPT-4.1 mini',
		inputPerMillion: 0.4,
		outputPerMillion: 1.6,
		cacheReadPerMillion: 0.1,
		aliases: ['GPT-4.1 mini', 'gpt-4.1-mini'],
		matchers: [/\bgpt 4 1 mini\b/]
	},
	{
		key: 'gpt-4.1-nano',
		displayName: 'GPT-4.1 nano',
		inputPerMillion: 0.1,
		outputPerMillion: 0.4,
		cacheReadPerMillion: 0.025,
		aliases: ['GPT-4.1 nano', 'gpt-4.1-nano'],
		matchers: [/\bgpt 4 1 nano\b/]
	},
	{
		key: 'claude-sonnet-5',
		displayName: 'Claude Sonnet 5',
		inputPerMillion: 3,
		outputPerMillion: 15,
		cacheReadPerMillion: 0.3,
		cacheWritePerMillion: 3.75,
		aliases: [
			'Claude Sonnet 5',
			'bedrock/converse_like/us.anthropic.claude-sonnet-5',
			'us.anthropic.claude-sonnet-5',
			'us.anthropic.claude-sonnet-5:0'
		],
		matchers: [/\bclaude sonnet 5\b/]
	},
	{
		key: 'claude-sonnet-4.6',
		displayName: 'Claude Sonnet 4.6',
		inputPerMillion: 3,
		outputPerMillion: 15,
		cacheReadPerMillion: 0.3,
		cacheWritePerMillion: 3.75,
		aliases: [
			'Claude Sonnet 4.6',
			'bedrock/converse_like/us.anthropic.claude-sonnet-4-6',
			'us.anthropic.claude-sonnet-4-6',
			'us.anthropic.claude-sonnet-4-6:0'
		],
		matchers: [/\bclaude sonnet 4 6\b/]
	},
	{
		key: 'claude-opus-5',
		displayName: 'Claude Opus 5',
		inputPerMillion: 5,
		outputPerMillion: 25,
		cacheReadPerMillion: 0.5,
		cacheWritePerMillion: 6.25,
		aliases: [
			'Claude Opus 5',
			'bedrock/converse_like/us.anthropic.claude-opus-5',
			'us.anthropic.claude-opus-5',
			'us.anthropic.claude-opus-5:0'
		],
		matchers: [/\bclaude opus 5\b/]
	},
	{
		key: 'claude-opus-4.8',
		displayName: 'Claude Opus 4.8',
		inputPerMillion: 5,
		outputPerMillion: 25,
		cacheReadPerMillion: 0.5,
		cacheWritePerMillion: 6.25,
		aliases: [
			'Claude Opus 4.8',
			'bedrock/converse_like/us.anthropic.claude-opus-4-8',
			'us.anthropic.claude-opus-4-8',
			'bedrock/converse_like/us.anthropic.claude-opus-4-8-v1',
			'us.anthropic.claude-opus-4-8-v1',
			'us.anthropic.claude-opus-4-8-v1:0'
		],
		matchers: [/\bclaude opus 4 8\b/]
	},
	{
		key: 'claude-opus-4.7',
		displayName: 'Claude Opus 4.7',
		inputPerMillion: 5,
		outputPerMillion: 25,
		cacheReadPerMillion: 0.5,
		cacheWritePerMillion: 6.25,
		aliases: [
			'Claude Opus 4.7',
			'bedrock/converse_like/us.anthropic.claude-opus-4-7',
			'us.anthropic.claude-opus-4-7',
			'bedrock/converse_like/us.anthropic.claude-opus-4-7-v1',
			'us.anthropic.claude-opus-4-7-v1',
			'us.anthropic.claude-opus-4-7-v1:0'
		],
		matchers: [/\bclaude opus 4 7\b/]
	},
	{
		key: 'claude-opus-4.6',
		displayName: 'Claude Opus 4.6',
		inputPerMillion: 5,
		outputPerMillion: 25,
		cacheReadPerMillion: 0.5,
		cacheWritePerMillion: 6.25,
		aliases: [
			'Claude Opus 4.6',
			'bedrock/converse_like/us.anthropic.claude-opus-4-6-v1',
			'us.anthropic.claude-opus-4-6-v1',
			'us.anthropic.claude-opus-4-6-v1:0'
		],
		matchers: [/\bclaude opus 4 6\b/]
	},
	{
		key: 'claude-haiku-4.5',
		displayName: 'Claude Haiku 4.5',
		inputPerMillion: 1,
		outputPerMillion: 5,
		cacheReadPerMillion: 0.1,
		cacheWritePerMillion: 1.25,
		aliases: [
			'Claude Haiku 4.5',
			'bedrock/converse_like/us.anthropic.claude-haiku-4-5-20251001-v1:0',
			'us.anthropic.claude-haiku-4-5-20251001-v1:0'
		],
		matchers: [/\bclaude haiku 4 5\b/]
	},
	{
		key: 'gemini-3.6-flash',
		displayName: 'Gemini 3.6 Flash',
		inputPerMillion: 2.7,
		outputPerMillion: 13.5,
		cacheReadPerMillion: 0.27,
		aliases: [
			'Gemini 3.6 Flash',
			'gemini-3.6-flash',
			'gemini/vertex/gemini-3.6-flash',
			'portico-gemini-vertex/gemini-3.6-flash'
		],
		matchers: [/\bgemini 3 6 flash\b/]
	},
	{
		// Listed before Gemini 3.5 Flash: the fuzzy fallback scans in table
		// order and /\bgemini 3 5 flash\b/ also matches "gemini 3 5 flash lite"
		// (same shadowing rule as GPT-5.6 Sol Pro before Sol).
		key: 'gemini-3.5-flash-lite',
		displayName: 'Gemini 3.5 Flash-Lite',
		inputPerMillion: 0.54,
		outputPerMillion: 4.5,
		cacheReadPerMillion: 0.054,
		aliases: [
			'Gemini 3.5 Flash-Lite',
			'gemini-3.5-flash-lite',
			'gemini/vertex/gemini-3.5-flash-lite',
			'portico-gemini-vertex/gemini-3.5-flash-lite'
		],
		matchers: [/\bgemini 3 5 flash lite\b/]
	},
	{
		key: 'gemini-3.5-flash',
		displayName: 'Gemini 3.5 Flash',
		inputPerMillion: 2.7,
		outputPerMillion: 16.2,
		cacheReadPerMillion: 0.27,
		aliases: [
			'Gemini 3.5 Flash',
			'gemini-3.5-flash',
			'gemini/vertex/gemini-3.5-flash',
			'portico-gemini-vertex/gemini-3.5-flash'
		],
		matchers: [/\bgemini 3 5 flash\b/]
	},
	{
		key: 'gemini-3.1-pro-preview',
		displayName: 'Gemini 3.1 Pro Preview',
		inputPerMillion: 3.6,
		outputPerMillion: 21.6,
		cacheReadPerMillion: 0.36,
		highContext: {
			thresholdPromptTokens: 200000,
			inputPerMillion: 7.2,
			outputPerMillion: 32.4,
			cacheReadPerMillion: 0.72
		},
		aliases: [
			'Gemini 3.1 Pro Preview',
			'gemini-3.1-pro-preview',
			'gemini/vertex/gemini-3.1-pro-preview',
			'portico-gemini-vertex/gemini-3.1-pro-preview'
		],
		matchers: [/\bgemini 3 1 pro preview\b/]
	},
	{
		key: 'gemini-3.1-flash-lite',
		displayName: 'Gemini 3.1 Flash-Lite',
		inputPerMillion: 0.45,
		outputPerMillion: 2.7,
		cacheReadPerMillion: 0.045,
		aliases: [
			'Gemini 3.1 Flash-Lite',
			'gemini-3.1-flash-lite',
			'gemini/vertex/gemini-3.1-flash-lite',
			'portico-gemini-vertex/gemini-3.1-flash-lite'
		],
		matchers: [/\bgemini 3 1 flash lite\b/]
	}
];

const NORMALIZED_ALIAS_TO_SPEC = new Map(
	MODEL_PRICING.flatMap((spec) => spec.aliases.map((alias) => [normalizeLookupValue(alias), spec] as const))
);

function normalizeLookupValue(value: string | null | undefined): string {
	return String(value ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function toFiniteNumber(value: unknown, fallback = 0): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	return fallback;
}

function toInteger(value: unknown, fallback = 0): number {
	return Math.max(0, Math.floor(toFiniteNumber(value, fallback)));
}

function roundCurrency(value: number): number {
	return Math.round((value + Number.EPSILON) * 1000000) / 1000000;
}

export function normalizePromptUsage(usage: Record<string, unknown> | undefined): NormalizedPromptUsage {
	const promptTokens = toInteger(
		usage?.prompt_tokens ?? usage?.promptTokens ?? usage?.input_tokens ?? usage?.inputTokens
	);
	const completionTokens = toInteger(
		usage?.completion_tokens ??
			usage?.completionTokens ??
			usage?.output_tokens ??
			usage?.outputTokens
	);
	const totalTokens = toInteger(
		usage?.total_tokens ?? usage?.totalTokens ?? promptTokens + completionTokens
	);
	const promptTokensDetails =
		usage?.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
			? usage.prompt_tokens_details
			: {};
	const cacheReadInputTokens = toInteger(
		usage?.cache_read_input_tokens ??
			usage?.cacheReadInputTokens ??
			usage?.cachedContentTokenCount ??
			usage?.cached_content_token_count ??
			promptTokensDetails?.cached_read_tokens ??
			promptTokensDetails?.cache_read_tokens ??
			promptTokensDetails?.cachedContentTokenCount ??
			promptTokensDetails?.cached_content_token_count ??
			promptTokensDetails?.cached_tokens
	);
	const cachedTokens = toInteger(
		usage?.cached_tokens ??
			usage?.cachedTokens ??
			usage?.cachedContentTokenCount ??
			usage?.cached_content_token_count ??
			promptTokensDetails?.cached_tokens ??
			promptTokensDetails?.cachedContentTokenCount ??
			promptTokensDetails?.cached_content_token_count ??
			promptTokensDetails?.cached_read_tokens ??
			promptTokensDetails?.cache_read_tokens ??
			cacheReadInputTokens
	);
	const cacheCreationInputTokens = toInteger(
		usage?.cache_creation_input_tokens ??
			usage?.cacheCreationInputTokens ??
			promptTokensDetails?.cached_write_tokens ??
			promptTokensDetails?.cache_write_tokens ??
			promptTokensDetails?.cache_creation_tokens
	);
	const cacheWriteInputTokens = toInteger(
		usage?.cache_write_input_tokens ??
			usage?.cacheWriteInputTokens ??
			promptTokensDetails?.cached_write_tokens ??
			promptTokensDetails?.cache_write_tokens ??
			promptTokensDetails?.cache_creation_tokens
	);
	const cost = Math.max(0, toFiniteNumber(usage?.cost, 0));

	return {
		promptTokens,
		completionTokens,
		totalTokens,
		cachedTokens,
		cacheReadInputTokens,
		cacheCreationInputTokens,
		cacheWriteInputTokens,
		cost
	};
}

export function resolveModelPricing(
	modelId?: string | null,
	modelName?: string | null
): ModelPricingSpec | null {
	const candidates = [modelName, modelId]
		.map((value) => normalizeLookupValue(value))
		.filter((value) => value.length > 0);

	for (const candidate of candidates) {
		const exact = NORMALIZED_ALIAS_TO_SPEC.get(candidate);
		if (exact) {
			return exact;
		}
	}

	for (const candidate of candidates) {
		for (const spec of MODEL_PRICING) {
			if (spec.matchers.some((matcher) => matcher.test(candidate))) {
				return spec;
			}
		}
	}

	return null;
}

function resolveEffectivePricingSpec(
	spec: ModelPricingSpec,
	promptTokens: number
): ModelPricingSpec {
	const highContext = spec.highContext;
	if (!highContext || promptTokens <= highContext.thresholdPromptTokens) {
		return spec;
	}

	return {
		...spec,
		inputPerMillion: highContext.inputPerMillion,
		outputPerMillion: highContext.outputPerMillion,
		cacheReadPerMillion: highContext.cacheReadPerMillion ?? spec.cacheReadPerMillion,
		cacheWritePerMillion: highContext.cacheWritePerMillion ?? spec.cacheWritePerMillion
	};
}

export function calculatePromptCacheMetrics(
	input: PromptCacheMetricsInput = {}
): PromptCacheMetrics {
	const normalizedUsage = normalizePromptUsage(
		input.usage && typeof input.usage === 'object' ? input.usage : undefined
	);
	const spec = resolveModelPricing(input.modelId, input.modelName);
	const promptTokens = toInteger(input.promptTokens ?? normalizedUsage.promptTokens);
	const completionTokens = toInteger(input.completionTokens ?? normalizedUsage.completionTokens);
	const actualCost = Math.max(
		0,
		toFiniteNumber(input.actualCost ?? input.cost ?? normalizedUsage.cost, 0)
	);

	if (!spec) {
		return {
			modelKey: null,
			modelName: input.modelName ? String(input.modelName) : null,
			supportsPricing: false,
			supportsCacheSavings: false,
			promptTokens,
			completionTokens,
			actualCost,
			effectiveActualCost: actualCost,
			estimatedActualCost: actualCost,
			estimatedCostWithoutCache: actualCost,
			netCacheSavings: 0,
			savingsRate: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			actualCacheReadCost: 0,
			actualCacheWriteCost: 0,
			uncachedEquivalentReadCost: 0,
			uncachedEquivalentWriteCost: 0,
			grossCacheReadSavings: 0,
			cacheWritePremium: 0
		};
	}

	const cacheReadTokens = Math.max(
		toInteger(input.cachedTokens ?? normalizedUsage.cachedTokens),
		toInteger(input.cacheReadInputTokens ?? normalizedUsage.cacheReadInputTokens)
	);
	const cacheWriteTokens = Math.max(
		toInteger(input.cacheCreationInputTokens ?? normalizedUsage.cacheCreationInputTokens),
		toInteger(input.cacheWriteInputTokens ?? normalizedUsage.cacheWriteInputTokens)
	);
	const effectiveSpec = resolveEffectivePricingSpec(spec, promptTokens);
	const inputRatePerToken = effectiveSpec.inputPerMillion / 1_000_000;
	const outputRatePerToken = effectiveSpec.outputPerMillion / 1_000_000;
	const cacheReadRatePerToken =
		effectiveSpec.cacheReadPerMillion != null
			? effectiveSpec.cacheReadPerMillion / 1_000_000
			: null;
	const cacheWriteRatePerToken =
		effectiveSpec.cacheWritePerMillion != null
			? effectiveSpec.cacheWritePerMillion / 1_000_000
			: null;
	const promptTokenEquivalent = Math.max(promptTokens, cacheReadTokens, cacheWriteTokens);

	const uncachedEquivalentReadCost = roundCurrency(cacheReadTokens * inputRatePerToken);
	const actualCacheReadCost = roundCurrency(
		cacheReadRatePerToken != null
			? cacheReadTokens * cacheReadRatePerToken
			: uncachedEquivalentReadCost
	);
	const grossCacheReadSavings = roundCurrency(
		uncachedEquivalentReadCost - actualCacheReadCost
	);

	const uncachedEquivalentWriteCost = roundCurrency(cacheWriteTokens * inputRatePerToken);
	const actualCacheWriteCost = roundCurrency(
		cacheWriteRatePerToken != null
			? cacheWriteTokens * cacheWriteRatePerToken
			: uncachedEquivalentWriteCost
	);
	const cacheWritePremium = roundCurrency(
		actualCacheWriteCost - uncachedEquivalentWriteCost
	);

	const estimatedCostWithoutCache = roundCurrency(
		promptTokenEquivalent * inputRatePerToken + completionTokens * outputRatePerToken
	);
	const estimatedActualCost = roundCurrency(
		Math.max(0, estimatedCostWithoutCache - grossCacheReadSavings + cacheWritePremium)
	);
	const effectiveActualCost = actualCost > 0 ? actualCost : estimatedActualCost;
	const netCacheSavings = roundCurrency(grossCacheReadSavings - cacheWritePremium);
	const effectiveNoCacheCost = roundCurrency(
		Math.max(0, effectiveActualCost + netCacheSavings)
	);
	const savingsRate =
		effectiveNoCacheCost > 0 ? netCacheSavings / effectiveNoCacheCost : 0;

	return {
		modelKey: spec.key,
		modelName: spec.displayName,
		supportsPricing: true,
		supportsCacheSavings:
			(cacheReadRatePerToken != null || cacheWriteRatePerToken != null) &&
			(cacheReadTokens > 0 || cacheWriteTokens > 0),
		promptTokens,
		completionTokens,
		actualCost,
		effectiveActualCost: roundCurrency(effectiveActualCost),
		estimatedActualCost,
		estimatedCostWithoutCache: roundCurrency(effectiveNoCacheCost),
		netCacheSavings,
		savingsRate,
		cacheReadTokens,
		cacheWriteTokens,
		actualCacheReadCost,
		actualCacheWriteCost,
		uncachedEquivalentReadCost,
		uncachedEquivalentWriteCost,
		grossCacheReadSavings,
		cacheWritePremium
	};
}
